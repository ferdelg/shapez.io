/**
 * Node codec for shapez .bin files (what storage_flinsh.js stores): LZ (compressX64) of
 * checksum + JSON of the key-compressed object. Reuses the game's own lzstring.js and
 * savegame_compressor.js, so it stays in step with the game.
 *
 *   import { decodeFile, encodeFile } from "./flinsh-savecodec.mjs";
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Standard CRC-32 (IEEE), same as the crc package's crc32 over the string's UTF-8 bytes
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = str => {
    let c = 0xffffffff;
    for (const b of Buffer.from(str, "utf8")) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapez-codec-"));
function load(rel, name) {
    const src = fs
        .readFileSync(path.join(root, rel), "utf8")
        .replace(/^import .*$/gm, "")
        .replace(/\bG_IS_DEV\b/g, "false");
    fs.writeFileSync(path.join(dir, name), src);
    return import(pathToFileURL(path.join(dir, name)).href);
}
const lz = await load("src/js/core/lzstring.js", "lzstring.mjs");
const sc = await load("src/js/savegame/savegame_compressor.js", "savegame_compressor.mjs");

const SALT = "Ec'])@^+*9zMevK3uMV4432x9%iK'="; // globalConfig.info.file
const CRC_PREFIX = "crc32".padEnd(32, "-");
const PREFIX = "\u0001"; // compressionPrefix

export function decodeFile(raw) {
    if (!raw.startsWith(PREFIX)) throw new Error("not a compressed shapez file");
    const text = lz.decompressX64(raw.substr(PREFIX.length));
    const checksum = text.substring(0, 40);
    const json = text.substr(40);
    const want = CRC_PREFIX + crc32(json + SALT).toString(16).padStart(8, "0");
    if (checksum !== want) throw new Error("checksum mismatch");
    return sc.decompressObject(JSON.parse(json));
}

export function encodeFile(obj) {
    const json = JSON.stringify(sc.compressObject(obj));
    const checksum = CRC_PREFIX + crc32(json + SALT).toString(16).padStart(8, "0");
    return PREFIX + lz.compressX64(checksum + json);
}
