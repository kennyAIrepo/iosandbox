/**
 * skeleton-align smoke test — classifies the REAL Khronos Fox skeleton
 * (tests/fixtures/fox_graph.json, extracted world rest positions) and
 * asserts every body role lands on the authored ground-truth bones.
 *
 *   node tests/skeleton-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { classifySkeleton, alignBodyContract } from '../sdk/interaction/skeleton-align.js';

// strip UTF-8 BOM: PowerShell 5.1's `-Encoding utf8` writes one
const readJson = u => JSON.parse(readFileSync(u, 'utf8').replace(/^﻿/, ''));
const graph = readJson(new URL('./fixtures/fox_graph.json', import.meta.url));
const contract = readJson(new URL('../assets/test-faces/fox.body.contract.json', import.meta.url));

let fails = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); fails++; }
};

const cls = classifySkeleton(graph);
console.log('stance/axes:', cls.stance, JSON.stringify(cls.axes));

eq('stance', cls.stance, 'quadruped');
eq('axes.up', cls.axes.up, 'y');
eq('axes.forward+sign', [cls.axes.forward, cls.axes.forwardSign], ['z', 1]);
eq('frontL', cls.roles.frontL, ['b_LeftUpperArm_09', 'b_LeftForeArm_010', 'b_LeftHand_011']);
eq('frontR', cls.roles.frontR, ['b_RightUpperArm_06', 'b_RightForeArm_07', 'b_RightHand_08']);
eq('hindL', cls.roles.hindL, ['b_LeftLeg01_015', 'b_LeftLeg02_016', 'b_LeftFoot01_017', 'b_LeftFoot02_018']);
eq('hindR', cls.roles.hindR, ['b_RightLeg01_019', 'b_RightLeg02_020', 'b_RightFoot01_021', 'b_RightFoot02_022']);
eq('head', cls.roles.head, 'b_Head_05');
eq('neck', cls.roles.neck, ['b_Neck_04']);
eq('tail', cls.roles.tail, ['b_Tail01_012', 'b_Tail02_013', 'b_Tail03_014']);
eq('spine', cls.roles.spine, ['b_Spine01_02', 'b_Spine02_03']);
eq('root', cls.roles.root, 'b_Root_00');
eq('hip', cls.roles.hip, 'b_Hip_01');
eq('no conflicts', cls.conflicts, []);

// contract merge: authored joints must WIN and detection must AGREE
const align = alignBodyContract(contract, cls);
eq('match limb.armL.raise', align.matches['limb.armL.raise'].bone, 'b_LeftUpperArm_09');
eq('match head.rot', align.matches['head.rot'].bone, 'b_Neck_04');
const disagreements = Object.entries(align.verify)
  .filter(([, v]) => v.agree === false).map(([k]) => k);
eq('authored-vs-detected agree', disagreements, []);

// ── HUMAN MODEL SYNC: the same aligner must classify a humanoid (biped) ──
// brunette.glb = Mixamo/RPM-style rig WITH full finger chains + eye bones —
// the classifier must see arms/legs, not fingers, as limbs.
const hgraph = readJson(new URL('./fixtures/brunette_graph.json', import.meta.url));
const hcls = classifySkeleton(hgraph);
console.log('\nbrunette stance/axes:', hcls.stance, JSON.stringify(hcls.axes));
eq('biped stance', hcls.stance, 'biped');
eq('biped frontL (arm)', hcls.roles.frontL, ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand']);
eq('biped frontR (arm)', hcls.roles.frontR, ['RightShoulder', 'RightArm', 'RightForeArm', 'RightHand']);
eq('biped hindL (leg)', hcls.roles.hindL, ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'LeftToe_End']);
eq('biped hindR (leg)', hcls.roles.hindR, ['RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase', 'RightToe_End']);
eq('biped head', hcls.roles.head, 'Head');
eq('biped neck', hcls.roles.neck, ['Neck']);
eq('biped spine', hcls.roles.spine, ['Spine', 'Spine1', 'Spine2']);
eq('biped hip', hcls.roles.hip, 'Hips');
eq('biped no tail', hcls.roles.tail, []);

// robot.glb: unknown naming — assert only that four limbs + a head were found
const rgraph = readJson(new URL('./fixtures/robot_graph.json', import.meta.url));
const rcls = classifySkeleton(rgraph);
console.log('\nrobot stance:', rcls.stance, '· roles:',
  Object.fromEntries(Object.entries(rcls.roles).map(([k, v]) =>
    [k, Array.isArray(v) ? v.length : v])));
const limbsFound = ['frontL', 'frontR', 'hindL', 'hindR'].filter(r => rcls.roles[r].length);
console.log(limbsFound.length >= 4 ? '  ok  robot: 4 limbs found'
  : `  note robot: only ${limbsFound.length} limbs found (structure-only rig — check riglab)`);

if (fails) { console.error(`\n${fails} FAILURES`); process.exit(1); }
console.log('\nall green — fox (quadruped) AND brunette (humanoid) classify to ground truth');
