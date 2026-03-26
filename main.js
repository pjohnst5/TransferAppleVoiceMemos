// Transfer Apple Voice Memos - Obsidian Plugin
// Transfers Apple Voice Memo transcripts into Daily Notes on startup.

const obsidian = require("obsidian");
const fs = require("fs");
const path = require("path");
const { exec, execSync } = require("child_process");

const VOICE_MEMOS_DIR = path.join(
	process.env.HOME,
	"Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings"
);

const VOICE_MEMOS_DB = path.join(VOICE_MEMOS_DIR, "CloudRecordings.db");

const MONTH_NAMES = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December"
];

const DAY_NAMES = [
	"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
];

// --- M4A atom parsing (ported from Python extract-apple-voice-memos-transcript) ---

function readAtomHeader(buf, offset) {
	if (offset + 8 > buf.length) return { type: null, size: 0, headerSize: 0 };
	const size = buf.readUInt32BE(offset);
	const type = buf.toString("ascii", offset + 4, offset + 8);
	if (size === 1 && offset + 16 <= buf.length) {
		const hi = buf.readUInt32BE(offset + 8);
		const lo = buf.readUInt32BE(offset + 12);
		const extendedSize = hi * 0x100000000 + lo;
		return { type, size: extendedSize, headerSize: 16 };
	}
	return { type, size, headerSize: 8 };
}

function findAtom(buf, start, end, targetType) {
	let pos = start;
	while (pos < end) {
		const { type, size, headerSize } = readAtomHeader(buf, pos);
		if (!type || size === 0) break;
		const atomEnd = pos + size;
		if (type === targetType) {
			return { dataStart: pos + headerSize, atomEnd };
		}
		pos = atomEnd;
	}
	return null;
}

function extractTranscript(filePath) {
	try {
		const buf = fs.readFileSync(filePath);
		const moov = findAtom(buf, 0, buf.length, "moov");
		if (!moov) return null;
		const trak = findAtom(buf, moov.dataStart, moov.atomEnd, "trak");
		if (!trak) return null;
		const udta = findAtom(buf, trak.dataStart, trak.atomEnd, "udta");
		if (!udta) return null;
		const tsrp = findAtom(buf, udta.dataStart, udta.atomEnd, "tsrp");
		if (!tsrp) return null;

		const jsonStr = buf.toString("utf-8", tsrp.dataStart, tsrp.atomEnd);
		const obj = JSON.parse(jsonStr);

		const parts = [];
		const as = obj.attributedString;
		if (Array.isArray(as)) {
			for (const item of as) {
				if (typeof item === "string") parts.push(item);
			}
		} else if (as && typeof as === "object") {
			for (const item of (as.runs || [])) {
				if (typeof item === "string") parts.push(item);
			}
		}

		const text = parts.join("").trim();
		return text || null;
	} catch {
		return null;
	}
}

// --- Date parsing ---

function parseDateFromFilename(filename) {
	const base = path.basename(filename, ".m4a");
	const datePart = base.split(" ")[0];
	if (datePart.length !== 8 || !/^\d{8}$/.test(datePart)) return null;
	const year = parseInt(datePart.substring(0, 4), 10);
	const month = parseInt(datePart.substring(4, 6), 10) - 1;
	const day = parseInt(datePart.substring(6, 8), 10);
	const dt = new Date(year, month, day);
	if (isNaN(dt.getTime())) return null;
	return dt;
}

function parseTimeFromFilename(filename) {
	const base = path.basename(filename, ".m4a");
	if (!base.includes(" ")) return "";
	const timePart = base.split(" ")[1].split("-")[0];
	if (timePart.length === 6 && /^\d{6}$/.test(timePart)) {
		let hours = parseInt(timePart.substring(0, 2), 10);
		const minutes = timePart.substring(2, 4);
		const suffix = hours >= 12 ? "PM" : "AM";
		if (hours === 0) hours = 12;
		else if (hours > 12) hours -= 12;
		return `${hours}:${minutes}${suffix}`;
	}
	return "";
}

// --- Daily note path generation ---
// Pattern: YYYY/MM-MMMM/YYYY-MM-DD-dddd.md

function dailyNotePath(dt) {
	const year = dt.getFullYear().toString();
	const monthNum = String(dt.getMonth() + 1).padStart(2, "0");
	const monthName = MONTH_NAMES[dt.getMonth()];
	const dayNum = String(dt.getDate()).padStart(2, "0");
	const dayName = DAY_NAMES[dt.getDay()];
	const folder = `${year}/${monthNum}-${monthName}`;
	const filename = `${year}-${monthNum}-${dayNum}-${dayName}.md`;
	return `${folder}/${filename}`;
}

function recordingsFolderPath(dt) {
	const year = dt.getFullYear().toString();
	const monthNum = String(dt.getMonth() + 1).padStart(2, "0");
	const monthName = MONTH_NAMES[dt.getMonth()];
	return `${year}/${monthNum}-${monthName}/Recordings`;
}

// --- Location/title lookup from CloudRecordings.db ---

function loadRecordingTitles() {
	try {
		const output = execSync(
			`sqlite3 "${VOICE_MEMOS_DB}" "SELECT ZPATH, ZENCRYPTEDTITLE FROM ZCLOUDRECORDING WHERE ZFLAGS != 4"`,
			{ encoding: "utf-8" }
		);
		const titles = {};
		for (const line of output.trim().split("\n")) {
			const sep = line.indexOf("|");
			if (sep === -1) continue;
			const filePath = line.substring(0, sep);
			const title = line.substring(sep + 1);
			titles[filePath] = title;
		}
		return titles;
	} catch {
		return {};
	}
}

function loadDeletedRecordings() {
	try {
		const output = execSync(
			`sqlite3 "${VOICE_MEMOS_DB}" "SELECT ZPATH FROM ZCLOUDRECORDING WHERE ZFLAGS = 4 OR ZEVICTIONDATE IS NOT NULL"`,
			{ encoding: "utf-8" }
		);
		return new Set(output.trim().split("\n").filter(Boolean));
	} catch {
		return new Set();
	}
}

function loadRecordingDurations() {
	try {
		const output = execSync(
			`sqlite3 "${VOICE_MEMOS_DB}" "SELECT ZPATH, ZDURATION FROM ZCLOUDRECORDING"`,
			{ encoding: "utf-8" }
		);
		const durations = {};
		for (const line of output.trim().split("\n")) {
			const sep = line.indexOf("|");
			if (sep === -1) continue;
			durations[line.substring(0, sep)] = parseFloat(line.substring(sep + 1)) || 0;
		}
		return durations;
	} catch {
		return {};
	}
}

// --- Trigger Voice Memos sync ---

function triggerVoiceMemosSync() {
	return new Promise((resolve) => {
		exec('open -g -a "/System/Applications/VoiceMemos.app"', (err) => {
			if (err) {
				console.log("Transfer Apple Voice Memos: Could not launch Voice Memos app", err);
			}
			setTimeout(resolve, 5000);
		});
	});
}

// --- Plugin ---

class TransferAppleVoiceMemosPlugin extends obsidian.Plugin {
	async onload() {
		this.app.workspace.onLayoutReady(() => {
			this.syncThenTransfer();
		});
	}

	async syncThenTransfer() {
		await triggerVoiceMemosSync();
		await this.transferMemos();
		try { execSync('osascript -e \'quit app "VoiceMemos"\''); } catch {}
	}

	async transferMemos() {
		let files;
		try {
			files = fs.readdirSync(VOICE_MEMOS_DIR);
		} catch (e) {
			new obsidian.Notice(
				"Transfer Apple Voice Memos: Cannot access Voice Memos directory. Grant Full Disk Access to Obsidian in System Settings."
			);
			console.error("Transfer Apple Voice Memos: Cannot read", VOICE_MEMOS_DIR, e);
			return;
		}

		const m4aFiles = files
			.filter((f) => f.toLowerCase().endsWith(".m4a"))
			.sort();

		if (m4aFiles.length === 0) {
			return;
		}

		let added = 0;
		let skipped = 0;
		let noTranscript = 0;

		const titles = loadRecordingTitles();
		const deleted = loadDeletedRecordings();
		const durations = loadRecordingDurations();

		for (const memoFile of m4aFiles) {
			if (deleted.has(memoFile)) {
				skipped++;
				continue;
			}
			if ((durations[memoFile] || 0) < 1) {
				skipped++;
				continue;
			}
			const memoPath = path.join(VOICE_MEMOS_DIR, memoFile);
			const dt = parseDateFromFilename(memoFile);
			if (!dt) {
				skipped++;
				continue;
			}

			const notePath = dailyNotePath(dt);
			const embed = `![[${memoFile}]]`;

			// Check if already added
			const existingFile = this.app.vault.getAbstractFileByPath(notePath);
			if (existingFile && existingFile instanceof obsidian.TFile) {
				const content = await this.app.vault.read(existingFile);
				if (content.includes(embed)) {
					skipped++;
					continue;
				}
			}

			const transcript = extractTranscript(memoPath);
			if (!transcript) noTranscript++;

			// Copy audio file into vault
			const recFolder = recordingsFolderPath(dt);
			await this.ensureFolderExists(recFolder);
			const destPath = `${recFolder}/${memoFile}`;
			const destFile = this.app.vault.getAbstractFileByPath(destPath);
			if (!destFile) {
				const audioBuf = fs.readFileSync(memoPath);
				await this.app.vault.createBinary(destPath, audioBuf);
			}

			const timeStr = parseTimeFromFilename(memoFile);
			const title = titles[memoFile] || "";
			let heading = "Voice Memo";
			if (title) heading += ` - ${title}`;
			if (timeStr) heading += ` - ${timeStr}`;

			const bodyText = transcript || "*No transcript available.*";
			const block = `\n## ${heading}\n${embed}\n${bodyText}\n`;

			if (existingFile && existingFile instanceof obsidian.TFile) {
				await this.app.vault.append(existingFile, block);
			} else {
				// Ensure folder exists
				const folderPath = notePath.substring(0, notePath.lastIndexOf("/"));
				await this.ensureFolderExists(folderPath);
				await this.app.vault.create(notePath, block.trimStart());
			}

			added++;
		}

		if (added > 0) {
			new obsidian.Notice(
				`Voice Memos: ${added} added, ${skipped} skipped.`
			);
		}
		console.log(
			`Transfer Apple Voice Memos: ${added} added, ${skipped} skipped, ${noTranscript} no transcript.`
		);
	}

	async ensureFolderExists(folderPath) {
		const parts = folderPath.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) {
				await this.app.vault.createFolder(current);
			}
		}
	}
}

module.exports = TransferAppleVoiceMemosPlugin;
