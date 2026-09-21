/**
 * _gen-packs.mjs — (re)generate tests/fixtures/hand-packs.json from sdk/game/pack-gen.js (CONTRACTS §9):
 *   { open, cup, flat, wave:[...60], throwRight:[...20] }   21-point {x,y,z} packs, tile world metres, hand plane z = -2
 *   node tests/_gen-packs.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFixtures } from '../sdk/game/pack-gen.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = path.join(here, 'fixtures', 'hand-packs.json');

const fx = await writeFixtures(FIXTURE_PATH);
console.log(`wrote ${path.relative(process.cwd(), FIXTURE_PATH)}: open/cup/flat + wave[${fx.wave.length}] + throwRight[${fx.throwRight.length}]`);
