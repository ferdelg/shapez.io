#!/usr/bin/env node
/**
 * Builds a large ("late-game sized") savegame from a real one, for measuring save sizes
 * and the store's chunking end to end.
 *
 *   node test/flinsh-make-save.mjs <harness-store.json> <entities> > big-store.json
 *
 * Input: a harness store dump (localStorage "flinsh-harness-store:shapez") holding a save the
 * game wrote. Output: the same store with that save's base replaced by <entities> buildings:
 * a belt-heavy mix like a real factory (belts, tunnels, balancers, extractors, cutters,
 * rotators, stackers, mixers, painters, trash), laid out without overlaps. Belt paths are
 * dropped so the game recomputes them on load. Items on belts aren't generated, so a real
 * base of the same size saves somewhat larger.
 */
import fs from "fs";
import { decodeFile, encodeFile } from "./flinsh-savecodec.mjs";

const [storeFile, countArg] = process.argv.slice(2);
const count = +countArg || 10000;
const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
const key = Object.keys(store).find(k => /savegame-[^/]+\.bin$/.test(k));
const save = decodeFile(store[key]);

// [code, width, weight]; 2-wide buildings keep rotation 0 so they stay inside their slot
const MIX = [
    [1, 1, 40], // belt straight
    [2, 1, 10], // belt left
    [3, 1, 10], // belt right
    [22, 1, 3], // tunnel entry
    [23, 1, 3], // tunnel exit
    [4, 2, 6], // balancer
    [7, 1, 5], // extractor
    [9, 2, 6], // cutter
    [11, 1, 5], // rotator
    [14, 2, 4], // stacker
    [15, 2, 2], // mixer
    [16, 2, 3], // painter
    [20, 1, 3], // trash
];
const total = MIX.reduce((a, m) => a + m[2], 0);
let seed = 12345;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = () => {
    let r = rand() * total;
    for (const m of MIX) if ((r -= m[2]) < 0) return m;
    return MIX[0];
};

const hub = save.dump.entities.find(e => e.components.StaticMapEntity.code === 26);
let uid = save.dump.entityMgr.nextUid;
const perRow = 120; // slots of 2 tiles -> 240 tiles wide
const entities = [hub];
for (let i = 0; i < count; ++i) {
    const [code, width] = pick();
    const rotation = width === 1 ? [0, 90, 180, 270][Math.floor(rand() * 4)] : 0;
    entities.push({
        uid: uid++,
        components: {
            StaticMapEntity: {
                origin: { x: -120 + (i % perRow) * 2, y: 6 + Math.floor(i / perRow) },
                rotation,
                originalRotation: rotation,
                code,
            },
        },
    });
}
save.dump.entities = entities;
save.dump.entityMgr.nextUid = uid;
save.dump.beltPaths = [];

store[key] = encodeFile(save);
process.stderr.write(`${key}: ${count} entities, ${(store[key].length / 1024).toFixed(0)} KB\n`);
process.stdout.write(JSON.stringify(store));
