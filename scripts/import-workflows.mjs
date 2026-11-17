#!/usr/bin/env node
// one-shot: import every JSON under 工作流/ into the MJoeUI backend,
// picking a nice Chinese name + the right category per file.
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const DIR = '/Users/majunhui11/Desktop/MJoeUI/工作流';
const API = 'http://127.0.0.1:3030/api';

// Human-friendly name + category + note per file. Everything else (base model,
// hash, node count, modelFile) is auto-detected by /api/workflows/inspect.
const META = {
  'G02-首尾帧-Wan2.2首尾帧视频.json': {
    name: 'Wan 2.2 · 首尾帧视频',
    category: 'i2v',
    note: '给一张首帧、一张尾帧 + 一段提示词，Wan 2.2 把中间的运动补出来。',
  },
  'P07-动作迁移-Wan2.2AnimateV4.json': {
    name: 'Wan 2.2 Animate · 动作迁移',
    category: 'i2v',
    note: '参考图 + 驱动视频（姿态 / 面部），把人物换成参考图的样子，保留原视频的动作。',
  },
  'P20-动作迁移-Wan2.2-Animate-动作迁移V9-多参考图.json': {
    name: 'Wan 2.2 Animate · 多参考图动作迁移',
    category: 'i2v',
    note: 'V9 加强版：最多 6 张参考图 + 驱动视频，更稳的身材比例迁移。',
  },
  'T04-Krea2-int8-角色设定三视图.json': {
    name: 'Krea 2 · 角色三视图',
    category: 't2i',
    note: 'FLUX Krea 2 int8 + LoRA，一次出角色正面 / 侧面 / 背面的设定图。',
  },
  'U0X-H3群主无限版.json': {
    name: 'Minimax H3 · 参考生视频',
    category: 'i2v',
    note: '最多 4 张参考图 + 提示词，Minimax H3 直接出带音频的短视频。',
  },
  'U11-Minimax-H3-图生视频-音频同步V2.json': {
    name: 'Minimax H3 · 图生视频 + 音频同步',
    category: 'i2v',
    note: '一张图 + 一段音频，H3 让画面跟着音频打节拍（口型、节奏）。',
  },
};

async function post(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const meta = META[file];
  if (!meta) { console.log('[skip]', file); continue; }
  const json = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'));
  const inspection = await post('/workflows/inspect', { json, fileName: file });
  if (inspection.duplicateOf) {
    console.log('[dup ]', file, '→', inspection.duplicateOf.name, inspection.duplicateOf.id);
    continue;
  }
  const r = await post('/workflows', {
    name: meta.name,
    category: meta.category,
    baseModel: inspection.baseModel,
    note: meta.note,
    json: inspection.json,
  });
  console.log('[ok  ]', r.workflow.id, '·', meta.name, '·', inspection.baseModel || '?');
}

const list = await (await fetch(API + '/workflows')).json();
console.log('\n', list.workflows.length, 'workflows in the DB:');
for (const w of list.workflows) {
  console.log(' ', w.id, '·', w.category, '·', w.name, '·', w.baseModel || '?');
}
