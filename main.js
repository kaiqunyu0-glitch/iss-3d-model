import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * Procedural ISS model for a phone browser.
 * Scale: 1 unit = 1 meter. Layout is only approximately correct.
 *
 * Three.js axes vs ISS body frame:
 *   +X forward (Harmony), -X aft (Zvezda)
 *   +Y zenith, -Y nadir / Earth
 *   +Z starboard (Columbus / S truss), -Z port (Kibo / P truss)
 */

const canvas = document.getElementById('c');
const loadingEl = document.getElementById('loading');
const infoEl = document.getElementById('info');
const infoTitle = document.getElementById('info-title');
const infoMeta = document.getElementById('info-meta');
const infoBody = document.getElementById('info-body');
const infoClose = document.getElementById('info-close');

const IDLE_RESUME_MS = 3500;
const TAP_MOVE_PX = 10;

let renderer, scene, camera, controls;
let issGroup, earthGroup;
let sunLight;
let selected = null;
let resumeTimer = 0;
let pointerDown = null;
const pickables = [];
const clock = new THREE.Clock();

function srgb(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function makeSolarTexture() {
  const w = 512;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#071428');
  g.addColorStop(0.5, '#14356e');
  g.addColorStop(1, '#0a1c3d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const cw = 16;
  const ch = 14;
  for (let y = 0; y < h; y += ch) {
    for (let x = 0; x < w; x += cw) {
      const odd = ((x / cw) + (y / ch)) % 2 === 0;
      ctx.fillStyle = odd ? 'rgba(28, 70, 150, 0.45)' : 'rgba(12, 36, 90, 0.35)';
      ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
      ctx.strokeStyle = 'rgba(210, 168, 64, 0.62)';
      ctx.lineWidth = 0.9;
      ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
    }
  }
  ctx.fillStyle = 'rgba(220, 180, 70, 0.55)';
  for (let x = 0; x < w; x += cw * 4) ctx.fillRect(x, 0, 2, h);
  const tex = srgb(new THREE.CanvasTexture(c));
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeRadiatorTexture() {
  const w = 256;
  const h = 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e8edf2';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(150, 160, 175, 0.85)';
  ctx.lineWidth = 2;
  for (let y = 8; y < h; y += 14) {
    ctx.beginPath();
    ctx.moveTo(6, y);
    ctx.lineTo(w - 6, y);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(120, 130, 145, 0.7)';
  ctx.strokeRect(3, 3, w - 6, h - 6);
  return srgb(new THREE.CanvasTexture(c));
}

function makePanelTexture(base, line) {
  const w = 256;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  for (let i = 32; i < w; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, h);
    ctx.moveTo(0, i);
    ctx.lineTo(w, i);
    ctx.stroke();
  }
  const tex = srgb(new THREE.CanvasTexture(c));
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeEarthTexture() {
  const w = 1024;
  const h = 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');

  const ocean = ctx.createLinearGradient(0, 0, 0, h);
  ocean.addColorStop(0, '#b9d8ee');
  ocean.addColorStop(0.12, '#2a6bb8');
  ocean.addColorStop(0.5, '#1a4f9c');
  ocean.addColorStop(0.88, '#2a6bb8');
  ocean.addColorStop(1, '#b9d8ee');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, w, h);

  // Stylized, soft continents (shapes are only suggestive, not a real map).
  function landEllipses(items) {
    for (const [lat, lon, latR, lonR, color, rot = 0] of items) {
      const x = ((lon + 180) / 360) * w;
      const y = ((90 - lat) / 180) * h;
      const rx = (lonR / 360) * w;
      const ry = (latR / 180) * h;
      ctx.fillStyle = color;
      for (const shift of [-w, 0, w]) {
        ctx.beginPath();
        ctx.ellipse(x + shift, y, rx, ry, rot, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  const land = '#4db34f';
  const landDark = '#3a9a42';
  const desert = '#c9a85a';
  landEllipses([
    // North America
    [50, -100, 22, 28, land, 0.5],
    [35, -95, 14, 18, land, -0.2],
    [15, -90, 10, 8, land, 0.3],
    // South America
    [-10, -62, 18, 10, land, 0.3],
    [-30, -65, 16, 8, land, 0.15],
    // Europe
    [54, 20, 10, 18, land, 0.15],
    [45, 10, 8, 10, land, 0],
    // Africa
    [10, 18, 16, 14, landDark, 0.2],
    [-8, 22, 18, 12, landDark, -0.15],
    [20, 10, 8, 16, desert, 0.1],
    // Arabia / India
    [25, 45, 8, 10, desert, 0.3],
    [22, 78, 10, 8, land, 0.4],
    // Asia
    [55, 90, 16, 40, land, 0.1],
    [35, 100, 14, 28, land, -0.2],
    [10, 105, 8, 16, land, 0.2],
    // Australia
    [-24, 134, 10, 16, land, 0.15],
    [-42, 170, 6, 8, land, 0.2],
  ]);


  // Polar ice (kept modest so a mid-latitude view does not become a white disk)
  ctx.fillStyle = 'rgba(245, 250, 255, 0.92)';
  ctx.fillRect(0, 0, w, 14);
  ctx.fillRect(0, h - 16, w, 16);
  ctx.fillStyle = 'rgba(230, 240, 255, 0.45)';
  ctx.fillRect(0, 14, w, 10);
  ctx.fillRect(0, h - 24, w, 8);

  // Subtle cloud bands
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  for (const [x, y, rw, rh, rot] of [
    [260, 210, 70, 8, 0.2], [520, 250, 80, 7, -0.15], [780, 190, 60, 7, 0.1],
  ]) {
    ctx.beginPath();
    ctx.ellipse(x, y, rw, rh, rot, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = srgb(new THREE.CanvasTexture(c));
  tex.flipY = false; // canvas y=0 (north) must stay at SphereGeometry v=0 (+Y)
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

const mats = {};

function initMaterials() {
  const solarMap = makeSolarTexture();
  solarMap.repeat.set(6, 2);
  mats.solar = new THREE.MeshStandardMaterial({
    map: solarMap,
    roughness: 0.35,
    metalness: 0.25,
    emissive: new THREE.Color(0x0a1a40),
    emissiveIntensity: 0.15,
    side: THREE.DoubleSide,
  });
  mats.solarFrame = new THREE.MeshStandardMaterial({
    color: 0x8a9098,
    roughness: 0.4,
    metalness: 0.7,
  });
  mats.radiator = new THREE.MeshStandardMaterial({
    map: makeRadiatorTexture(),
    roughness: 0.55,
    metalness: 0.15,
    color: 0xf2f5f8,
    side: THREE.DoubleSide,
  });
  mats.truss = new THREE.MeshStandardMaterial({
    color: 0x8d949c,
    roughness: 0.45,
    metalness: 0.7,
  });
  mats.trussDark = new THREE.MeshStandardMaterial({
    color: 0x4a5058,
    roughness: 0.5,
    metalness: 0.65,
  });
  mats.blanket = new THREE.MeshStandardMaterial({
    color: 0xd8dbe0,
    roughness: 0.85,
    metalness: 0.05,
    map: makePanelTexture('#d4d8de', 'rgba(150,155,165,0.45)'),
  });
  mats.us = new THREE.MeshStandardMaterial({
    color: 0xe8eaee,
    roughness: 0.55,
    metalness: 0.2,
    map: makePanelTexture('#e6e8ed', 'rgba(170,175,185,0.4)'),
  });
  mats.russian = new THREE.MeshStandardMaterial({
    color: 0xe4e0d6,
    roughness: 0.6,
    metalness: 0.12,
    map: makePanelTexture('#e4e0d6', 'rgba(160,150,130,0.35)'),
  });
  mats.kibo = new THREE.MeshStandardMaterial({
    color: 0xe9edf2,
    roughness: 0.5,
    metalness: 0.22,
    map: makePanelTexture('#edf0f4', 'rgba(155,165,180,0.4)'),
  });
  mats.esa = new THREE.MeshStandardMaterial({
    color: 0xdfe6ee,
    roughness: 0.5,
    metalness: 0.25,
    map: makePanelTexture('#dfe6ee', 'rgba(140,155,175,0.4)'),
  });
  mats.ring = new THREE.MeshStandardMaterial({
    color: 0x6a7380,
    roughness: 0.35,
    metalness: 0.8,
  });
  mats.window = new THREE.MeshStandardMaterial({
    color: 0x1a2a44,
    roughness: 0.15,
    metalness: 0.4,
    emissive: new THREE.Color(0x4a80b8),
    emissiveIntensity: 0.35,
  });
  mats.gold = new THREE.MeshStandardMaterial({
    color: 0xc4a046,
    roughness: 0.35,
    metalness: 0.8,
  });
  mats.engine = new THREE.MeshStandardMaterial({
    color: 0x33383f,
    roughness: 0.4,
    metalness: 0.7,
  });
  mats.earth = new THREE.MeshStandardMaterial({
    map: makeEarthTexture(),
    roughness: 0.86,
    metalness: 0.0,
  });
}

function boxMesh(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = false;
  return m;
}

function cylMesh(rTop, rBot, h, segs, mat) {
  return new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, segs), mat);
}

/** Cylinder along X (modules). */
function tubeX(r, length, mat, segs = 24) {
  const m = cylMesh(r, r, length, segs, mat);
  m.rotation.z = Math.PI / 2;
  return m;
}

/** Cylinder along Z. */
function tubeZ(r, length, mat, segs = 20) {
  const m = cylMesh(r, r, length, segs, mat);
  m.rotation.x = Math.PI / 2;
  return m;
}

/** Cylinder along Y (default). */
function tubeY(r, length, mat, segs = 20) {
  return cylMesh(r, r, length, segs, mat);
}

function dockingRing(radius, along = 'x') {
  const t = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.08, 8, 24),
    mats.ring,
  );
  if (along === 'x') t.rotation.y = Math.PI / 2;
  else if (along === 'z') t.rotation.x = Math.PI / 2;
  return t;
}

function pickable(group, id, title, meta, body) {
  group.name = id;
  group.userData = { pickable: true, id, title, meta, body };
  pickables.push(group);
  return group;
}

function addEnds(group, length, radius, along = 'x') {
  const r1 = dockingRing(radius * 0.92, along);
  const r2 = dockingRing(radius * 0.92, along);
  if (along === 'x') {
    r1.position.x = length / 2;
    r2.position.x = -length / 2;
  } else if (along === 'z') {
    r1.position.z = length / 2;
    r2.position.z = -length / 2;
  } else {
    r1.position.y = length / 2;
    r2.position.y = -length / 2;
  }
  group.add(r1, r2);
}

function makePressurized({
  id, title, meta, body, length, radius, material, axis = 'x', segs = 24,
}) {
  const g = new THREE.Group();
  let bodyMesh;
  if (axis === 'x') bodyMesh = tubeX(radius, length, material, segs);
  else if (axis === 'z') bodyMesh = tubeZ(radius, length, material, segs);
  else bodyMesh = tubeY(radius, length, material, segs);
  g.add(bodyMesh);
  addEnds(g, length, radius, axis);
  return pickable(g, id, title, meta, body);
}

function makeNode(id, title, meta, body, length, radius, material) {
  const g = makePressurized({ id, title, meta, body, length, radius, material, axis: 'x' });
  // Radial berthing ports (short stubs) so side modules read as attached.
  const stubLen = 0.7;
  const stubR = radius * 0.55;
  const ports = [
    [0, 0, radius + stubLen / 2, 'z'],
    [0, 0, -(radius + stubLen / 2), 'z'],
    [0, radius + stubLen / 2, 0, 'y'],
    [0, -(radius + stubLen / 2), 0, 'y'],
  ];
  for (const [x, y, z, ax] of ports) {
    const stub = ax === 'z' ? tubeZ(stubR, stubLen, material, 16) : tubeY(stubR, stubLen, material, 16);
    stub.position.set(x, y, z);
    g.add(stub);
  }
  return g;
}

function buildModules() {
  const modules = new THREE.Group();
  modules.name = 'modules';

  // --- Unity (Node 1) at the origin ---
  const unity = makeNode(
    'unity',
    '團結號（Unity / Node 1）',
    '1998 年發射　美國 NASA',
    '國際太空站第一個美國艙段，像一座「轉運站」，把俄羅斯艙段和後面的美國實驗艙連在一起。兩側還接了寧靜號與探索氣閘艙。',
    5.5, 2.25, mats.us,
  );
  unity.position.set(0, 0, 0);
  modules.add(unity);

  // PMA-1 (short adapter, aft of Unity)
  const pma1 = tubeX(1.1, 1.8, mats.us, 16);
  pma1.position.set(-3.65, 0, 0);
  modules.add(pma1);

  // --- Zarya ---
  const zarya = makePressurized({
    id: 'zarya',
    title: '曙光號（Zarya）',
    meta: '1998 年發射　俄羅斯製造，美國出資',
    body: '整座太空站最早升空的艙段。剛開始負責電力、推進和儲物，現在主要當作儲藏與連接艙，位於團結號與星辰號之間。',
    length: 12.6, radius: 2.05, material: mats.russian,
  });
  // slightly narrower aft/forward steps for a less "perfect tube" look
  const zaryaStep = tubeX(1.7, 2.2, mats.russian, 20);
  zaryaStep.position.x = 5.4;
  zarya.add(zaryaStep);
  zarya.position.set(-11.05, 0, 0);
  modules.add(zarya);

  // --- Zvezda ---
  const zvezda = new THREE.Group();
  const zvMain = tubeX(2.1, 9.2, mats.russian, 24);
  zvMain.position.x = -1.0;
  zvezda.add(zvMain);
  const zvFwd = tubeX(1.5, 3.4, mats.russian, 20);
  zvFwd.position.x = 5.3;
  zvezda.add(zvFwd);
  const zvAft = cylMesh(1.3, 1.7, 1.6, 20, mats.russian);
  zvAft.rotation.z = Math.PI / 2;
  zvAft.position.x = -6.55;
  zvezda.add(zvAft);
  addEnds(zvezda, 13.1, 1.7, 'x');
  // aft engines
  for (const z of [-0.7, 0.7]) {
    const eng = cylMesh(0.28, 0.42, 0.8, 12, mats.engine);
    eng.rotation.z = Math.PI / 2;
    eng.position.set(-7.4, -0.15, z);
    zvezda.add(eng);
  }
  // small side windows
  for (const [x, y] of [[-1, 1.7], [1.5, 1.7]]) {
    const w = boxMesh(0.5, 0.35, 0.08, mats.window, x, y, 0);
    zvezda.add(w);
  }
  pickable(
    zvezda,
    'zvezda',
    '星辰號（Zvezda）',
    '2000 年發射　俄羅斯 Roscosmos',
    '俄羅斯的服務艙，是早期的生活區與指揮中心，負責生命維持、推進和控制。艙尾有發動機，兩側還有較舊的太陽能板。',
  );
  zvezda.position.set(-24.4, 0, 0);
  modules.add(zvezda);

  // Zvezda solar arrays (smaller, older Russian wings, along ±Z)
  const ruSolar = makeRussianArrays();
  ruSolar.position.set(-24.4, 0.4, 0);
  modules.add(ruSolar);

  // --- Destiny ---
  const destiny = makePressurized({
    id: 'destiny',
    title: '命運號（Destiny）',
    meta: '2001 年發射　美國 NASA',
    body: '美國的主要科學實驗艙，也是整合桁架（S0）固定的地方。裡面有許多實驗機櫃，是太空站上重要的實驗室之一。',
    length: 8.5, radius: 2.15, material: mats.us,
  });
  // a few windows on nadir / sides
  destiny.add(boxMesh(0.55, 0.08, 0.45, mats.window, 1.2, -2.12, 0));
  destiny.add(boxMesh(0.55, 0.08, 0.45, mats.window, -0.8, -2.12, 0));
  destiny.position.set(7.0, 0, 0);
  modules.add(destiny);

  // --- Harmony (Node 2) ---
  const harmony = makeNode(
    'harmony',
    '和諧號（Harmony / Node 2）',
    '2007 年發射　歐洲為 NASA 建造',
    '位於命運號前方的節點艙。右舷接歐洲哥倫布號，左舷接日本希望號，前方還可讓太空船對接，是「前段樞紐」。',
    7.2, 2.2, mats.us,
  );
  harmony.position.set(14.85, 0, 0);
  modules.add(harmony);

  // PMA-2 forward of Harmony
  const pma2 = new THREE.Group();
  const pma2body = cylMesh(0.9, 1.2, 2.0, 16, mats.us);
  pma2body.rotation.z = Math.PI / 2;
  pma2.add(pma2body);
  pma2.position.set(19.45, 0, 0);
  modules.add(pma2);

  // --- Columbus (starboard of Harmony) ---
  const columbus = makePressurized({
    id: 'columbus',
    title: '哥倫布號（Columbus）',
    meta: '2008 年發射　歐洲太空總署 ESA',
    body: '歐洲的主要實驗艙，接在和諧號右舷。裡面進行生物、物理和材料等實驗，是歐洲參與國際太空站的核心艙段。',
    length: 6.9, radius: 2.15, material: mats.esa, axis: 'z',
  });
  columbus.position.set(14.85, 0, 5.7);
  modules.add(columbus);

  // --- Kibo complex (port of Harmony) ---
  const kibo = new THREE.Group();
  const kiboPm = tubeZ(2.2, 11.2, mats.kibo, 24);
  kibo.add(kiboPm);
  addEnds(kibo, 11.2, 2.2, 'z');
  // ELM-PS on zenith of PM (short cylinder up)
  const elm = tubeY(2.15, 4.0, mats.kibo, 20);
  elm.position.set(0, 4.2, -1.2);
  kibo.add(elm);
  const elmRing = dockingRing(2.0, 'y');
  elmRing.position.set(0, 6.2, -1.2);
  kibo.add(elmRing);
  // Exposed facility extending further port
  const ef = boxMesh(2.4, 1.0, 5.6, mats.truss, 0, -0.3, -8.5);
  kibo.add(ef);
  kibo.add(boxMesh(1.2, 1.1, 1.4, mats.gold, 0, 0.4, -7.4));
  kibo.add(boxMesh(1.1, 1.0, 1.3, mats.us, 0.2, 0.35, -9.2));
  pickable(
    kibo,
    'kibo',
    '希望號（Kibo）',
    '2008–2009 年發射　日本 JAXA',
    '目前單一模組裡最大的實驗艙，包含加壓實驗艙、上方的實驗後勤艙，以及伸出艙外的暴露設施，可在真空中做實驗。',
  );
  kibo.position.set(14.85, 0, -7.85);
  modules.add(kibo);

  // --- Tranquility (port of Unity) + Cupola (nadir) ---
  const tranq = makePressurized({
    id: 'tranquility',
    title: '寧靜號（Tranquility / Node 3）',
    meta: '2010 年發射　歐洲為 NASA 建造',
    body: '接在團結號左舷的節點艙，裝有生命維持、再生循環與運動設備。下方連著觀景穹頂（Cupola）。',
    length: 6.7, radius: 2.2, material: mats.esa, axis: 'z',
  });
  tranq.position.set(0, 0, -5.6);
  modules.add(tranq);

  const cupola = buildCupola();
  cupola.position.set(0, -3.4, -5.6);
  modules.add(cupola);

  // --- Quest (starboard of Unity) ---
  const quest = new THREE.Group();
  const qEquip = tubeZ(2.0, 3.2, mats.us, 20);
  qEquip.position.z = -0.9;
  quest.add(qEquip);
  const qCrew = tubeZ(1.55, 2.4, mats.us, 18);
  qCrew.position.z = 1.9;
  quest.add(qCrew);
  addEnds(quest, 5.5, 1.7, 'z');
  pickable(
    quest,
    'quest',
    '探索氣閘艙（Quest）',
    '2001 年發射　美國 NASA',
    '美國段的主要出艙氣閘，太空人從這裡穿上太空衣走到艙外。接在團結號右舷。',
  );
  quest.position.set(0, 0, 5.1);
  modules.add(quest);

  // --- Poisk (zenith of Zvezda) ---
  const poisk = makePressurized({
    id: 'poisk',
    title: '搜尋號（Poisk）',
    meta: '2009 年發射　俄羅斯 Roscosmos',
    body: '接在星辰號上方（天頂方向）的小型對接與氣閘模組，可供俄羅斯太空船停靠，也能作為出艙口。',
    length: 4.0, radius: 1.25, material: mats.russian, axis: 'y',
  });
  poisk.position.set(-23.2, 3.3, 0);
  modules.add(poisk);

  // --- Rassvet (nadir of Zarya) ---
  const rassvet = makePressurized({
    id: 'rassvet',
    title: '黎明號（Rassvet）',
    meta: '2010 年發射　俄羅斯 Roscosmos',
    body: '接在曙光號下方的模組，主要用來儲物，並提供一個對接口給俄羅斯載人太空船。',
    length: 5.5, radius: 1.15, material: mats.russian, axis: 'y',
  });
  rassvet.position.set(-9.5, -3.85, 0);
  modules.add(rassvet);

  // --- Nauka (nadir of Zvezda) ---
  const nauka = makePressurized({
    id: 'nauka',
    title: '科學號（Nauka）',
    meta: '2021 年發射　俄羅斯 Roscosmos',
    body: '俄羅斯較新的多功能實驗艙，接在星辰號下方（朝地球方向）。提供額外的實驗空間、儲物與生命維持能力。',
    length: 11.0, radius: 2.05, material: mats.russian, axis: 'y',
  });
  // slightly offset so it hangs clearly below Zvezda
  nauka.position.set(-25.5, -7.6, 0);
  modules.add(nauka);

  return modules;
}

function buildCupola() {
  const g = new THREE.Group();
  const base = tubeY(1.45, 0.7, mats.esa, 16);
  base.position.y = 0.55;
  g.add(base);
  // truncated dome body
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1.45, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
    mats.esa,
  );
  dome.position.y = 0.2;
  g.add(dome);
  // top window
  const top = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), mats.window);
  top.rotation.x = -Math.PI / 2;
  top.position.y = 1.52;
  g.add(top);
  // six side windows around the dome
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    const w = boxMesh(0.7, 0.62, 0.06, mats.window);
    w.position.set(Math.sin(ang) * 1.22, 0.55, Math.cos(ang) * 1.22);
    w.lookAt(0, 0.55, 0);
    g.add(w);
  }
  return pickable(
    g,
    'cupola',
    '觀景穹頂（Cupola）',
    '2010 年發射　歐洲太空總署 ESA',
    '有七扇窗戶的觀景艙，接在寧靜號下方、朝向地球。常用來觀察地球，也方便操作艙外機械臂。',
  );
}

function makeRussianArrays() {
  const g = new THREE.Group();
  g.name = 'zvezda-arrays';
  const wingMat = mats.solar;
  const span = 11.5;
  const width = 3.2;
  const thick = 0.08;
  for (const side of [-1, 1]) {
    const wing = boxMesh(width, thick, span, wingMat, 0, 0, side * (span / 2 + 2.4));
    wing.rotation.x = side * 0.12;
    g.add(wing);
    const boom = tubeZ(0.12, 2.4, mats.trussDark, 8);
    boom.position.z = side * 1.3;
    g.add(boom);
  }
  pickable(
    g,
    'zvezda-arrays',
    '星辰號太陽能板',
    '隨星辰號於 2000 年進入軌道　俄羅斯',
    '服務艙兩側較舊、較小的太陽能板，早期為俄羅斯段提供電力。比美國段桁架上的大型太陽能翼小很多。',
  );
  return g;
}

function trussSegment(length, detail = true) {
  const g = new THREE.Group();
  const size = 2.2;
  g.add(boxMesh(size * 0.22, size, length, mats.truss, size * 0.45, 0, 0));
  g.add(boxMesh(size * 0.22, size, length, mats.truss, -size * 0.45, 0, 0));
  g.add(boxMesh(size, size * 0.18, length, mats.trussDark, 0, size * 0.48, 0));
  g.add(boxMesh(size, size * 0.18, length, mats.trussDark, 0, -size * 0.48, 0));
  if (detail) {
    const bays = Math.max(2, Math.round(length / 3.4));
    const bay = length / bays;
    for (let i = 0; i <= bays; i++) {
      const z = -length / 2 + i * bay;
      g.add(boxMesh(size, size, 0.16, mats.truss, 0, 0, z));
      if (i < bays) {
        const mid = z + bay / 2;
        const brace = boxMesh(0.1, Math.hypot(size, bay) * 0.92, 0.1, mats.trussDark);
        brace.position.set(size * 0.5, 0, mid);
        brace.rotation.x = Math.atan2(size, bay);
        g.add(brace);
        const brace2 = brace.clone();
        brace2.position.x = -size * 0.5;
        brace2.rotation.x = -Math.atan2(size, bay);
        g.add(brace2);
      }
    }
  }
  // utility tray along +X (forward face of truss)
  g.add(boxMesh(0.7, 0.35, length * 0.96, mats.gold, size * 0.7, -0.2, 0));
  return g;
}

function buildTruss() {
  const truss = new THREE.Group();
  truss.name = 'truss';

  // Approximate ITS lengths totaling ~109 m, S0 centered above Destiny.
  // z ranges: P6..S6
  const segs = [
    { id: 'P6', z: -50.15, len: 10.5 },
    { id: 'P5', z: -43.3, len: 3.2 },
    { id: 'P4', z: -36.45, len: 10.5 },
    { id: 'P3', z: -25.45, len: 11.5 },
    { id: 'P1', z: -13.2, len: 13.0 },
    { id: 'S0', z: 0, len: 13.4 },
    { id: 'S1', z: 13.2, len: 13.0 },
    { id: 'S3', z: 25.45, len: 11.5 },
    { id: 'S4', z: 36.45, len: 10.5 },
    { id: 'S5', z: 43.3, len: 3.2 },
    { id: 'S6', z: 50.15, len: 10.5 },
  ];

  const assembly = new THREE.Group();
  for (const s of segs) {
    const seg = trussSegment(s.len, s.len > 4);
    seg.position.z = s.z;
    assembly.add(seg);
  }
  // S0 "nook" / zenith-to-Destiny struts
  assembly.add(boxMesh(2.6, 2.4, 4.5, mats.blanket, 0, -2.0, 0));
  assembly.add(boxMesh(1.2, 1.6, 1.2, mats.truss, 0, -3.3, 0));

  pickable(
    assembly,
    'truss',
    '整合桁架（Integrated Truss）',
    '2000–2009 年分段組裝　美國 NASA 為主',
    '橫貫太空站的長桁架，由 S0、S1/P1 到最外側的 S6/P6 等段組成，全長約 109 公尺。上面掛著太陽能板、散熱板，並為整站提供結構與電力傳輸。本模型比例僅大致正確。',
  );
  truss.add(assembly);

  // SARJ joints (big rotating rings) between P3/P4 and S3/S4
  for (const z of [-31.2, 31.2]) {
    const sarj = tubeZ(1.7, 1.1, mats.ring, 24);
    sarj.position.set(0, 0, z);
    truss.add(sarj);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.95, 1.95, 0.25, 24), mats.gold);
    disc.rotation.x = Math.PI / 2;
    disc.position.z = z;
    truss.add(disc);
  }

  return truss;
}

function makeSolarWing(length, width) {
  const g = new THREE.Group();
  const panel = boxMesh(length, 0.07, width, mats.solar);
  g.add(panel);
  // mast / longeron along the length
  g.add(boxMesh(length + 0.4, 0.16, 0.22, mats.solarFrame, 0, 0.08, 0));
  g.add(boxMesh(length + 0.4, 0.16, 0.22, mats.solarFrame, 0, 0.08, width * 0.48));
  g.add(boxMesh(length + 0.4, 0.16, 0.22, mats.solarFrame, 0, 0.08, -width * 0.48));
  // outer tip boom
  g.add(boxMesh(0.2, 0.2, width + 0.3, mats.solarFrame, length / 2 + 0.1, 0.05, 0));
  return g;
}

function buildSolarArrays() {
  const group = new THREE.Group();
  const wingLen = 34.0;
  const wingWid = 11.6;
  const stations = [
    { z: -50.15, name: 'P6' },
    { z: -36.45, name: 'P4' },
    { z: 36.45, name: 'S4' },
    { z: 50.15, name: 'S6' },
  ];

  const cluster = new THREE.Group();
  for (const st of stations) {
    for (const dir of [-1, 1]) {
      const wing = makeSolarWing(wingLen, wingWid);
      // root slightly away from truss; wing extends along ±X
      wing.position.set(dir * (wingLen / 2 + 2.3), 0.2, st.z);
      // slight tilt so the gold-blue face is visible, not edge-on
      wing.rotation.z = dir * 0.06;
      wing.rotation.x = 0.28;
      cluster.add(wing);
    }
    // beta gimbal / mast housing
    cluster.add(boxMesh(2.6, 1.4, 2.0, mats.trussDark, 0, 0.3, st.z));
    const mastF = tubeX(0.18, 2.2, mats.truss, 8);
    mastF.position.set(1.4, 0.3, st.z);
    cluster.add(mastF);
    const mastA = tubeX(0.18, 2.2, mats.truss, 8);
    mastA.position.set(-1.4, 0.3, st.z);
    cluster.add(mastA);
  }
  pickable(
    cluster,
    'solar',
    '太陽能板翼（Solar Arrays）',
    '四對、共八片大型翼　美國 NASA',
    '裝在桁架外側的 P4、P6、S4、S6 上，一共四對、八片大翼。深藍色電池配金色匯流條，是太空站最顯眼的結構，負責大部分電力。本模型有格子紋理，但細節經過簡化。',
  );
  group.add(cluster);
  return group;
}

function buildRadiators() {
  const group = new THREE.Group();

  // Main thermal radiators on S1 / P1: three large white panels each, hanging slightly nadir and along X
  const main = new THREE.Group();
  const panelW = 3.4;
  const panelL = 11.2;
  for (const z0 of [-13.2, 13.2]) {
    for (let i = -1; i <= 1; i++) {
      const p = boxMesh(panelL, 0.08, panelW, mats.radiator);
      p.position.set(i * 0.2, -3.4, z0 + i * (panelW + 0.35));
      p.rotation.z = 0.18;
      p.rotation.x = z0 > 0 ? -0.04 : 0.04;
      main.add(p);
    }
    // rotary joint housing
    main.add(boxMesh(1.6, 1.2, 1.6, mats.truss, 0, -1.6, z0));
  }
  pickable(
    main,
    'radiators',
    '主散熱板（Thermal Radiators）',
    '位於 S1 / P1 桁架段　美國 NASA',
    '大型白色散熱板，用來把站內設備產生的熱排到太空。主要裝在 S1 與 P1 段，可以轉動以調整散熱方向。',
  );
  group.add(main);

  // Smaller PV radiators near the solar power modules
  const pv = new THREE.Group();
  for (const z of [-50.15, -36.45, 36.45, 50.15]) {
    const p = boxMesh(9.5, 0.07, 2.6, mats.radiator, 0, -2.4, z);
    p.rotation.z = 0.7;
    pv.add(p);
  }
  pickable(
    pv,
    'pv-radiators',
    '太陽能模組散熱板（PV Radiators）',
    '位於 P4/P6、S4/S6 附近　美國 NASA',
    '比主散熱板小的白色板，裝在外側太陽能模組旁，用來帶走太陽能電池與電力設備的熱。',
  );
  group.add(pv);

  return group;
}

function buildISS() {
  const iss = new THREE.Group();
  iss.name = 'ISS';

  const modules = buildModules();
  iss.add(modules);

  // Truss sits on the zenith of Destiny (x≈7, y≈4.6)
  const truss = buildTruss();
  truss.position.set(7.0, 4.6, 0);
  iss.add(truss);

  const solar = buildSolarArrays();
  solar.position.set(7.0, 4.8, 0);
  iss.add(solar);

  const rads = buildRadiators();
  rads.position.set(7.0, 4.6, 0);
  iss.add(rads);

  return iss;
}

function buildEarth() {
  const g = new THREE.Group();
  g.name = 'Earth';
  const radius = 96;
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 64, 48),
    mats.earth,
  );
  earth.name = 'earth-mesh';
  // Tilt mid-latitudes toward the default camera; yaw is chosen so land is visible.
  earth.rotation.x = 1.15;
  earth.rotation.y = 2.45;
  earth.rotation.z = 0.12;
  g.add(earth);

  const atmoMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x5db7ff) },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float f = pow(1.0 - abs(dot(vNormal, vView)), 2.4);
        gl_FragColor = vec4(uColor, f * 0.85);
      }
    `,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.045, 48, 32), atmoMat);
  g.add(atmo);

  g.position.set(8, -155, 0);
  return g;
}

function buildStars() {
  const count = 4500;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 400 + Math.random() * 700;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i * 3 + 2] = r * Math.cos(phi);
    const t = Math.random();
    const c = new THREE.Color().setHSL(t * 0.12 + 0.55, 0.15, 0.7 + Math.random() * 0.3);
    if (t > 0.85) c.setHSL(0.08, 0.35, 0.9);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.6,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const stars = new THREE.Points(geo, mat);
  stars.name = 'stars';
  return stars;
}

function setHighlight(group, on) {
  if (!group) return;
  group.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const list = Array.isArray(obj.material) ? obj.material : [obj.material];
    if (on) {
      if (!obj.userData._origMat) {
        obj.userData._origMat = obj.material;
        obj.material = Array.isArray(obj.material)
          ? obj.material.map((m) => m.clone())
          : obj.material.clone();
      }
      const cloned = Array.isArray(obj.material) ? obj.material : [obj.material];
      cloned.forEach((m) => {
        if (m.emissive) {
          m.emissive.set(0x2a7fff);
          m.emissiveIntensity = 0.55;
        }
      });
    } else if (obj.userData._origMat) {
      const cloned = Array.isArray(obj.material) ? obj.material : [obj.material];
      cloned.forEach((m) => m.dispose && m.dispose());
      obj.material = obj.userData._origMat;
      delete obj.userData._origMat;
    }
  });
}

function showInfo(data) {
  infoTitle.textContent = data.title;
  infoMeta.textContent = data.meta;
  infoBody.textContent = data.body;
  infoEl.hidden = false;
}

function hideInfo() {
  infoEl.hidden = true;
  setHighlight(selected, false);
  selected = null;
}

function pickFromObject(obj) {
  let cur = obj;
  while (cur) {
    if (cur.userData && cur.userData.pickable) return cur;
    cur = cur.parent;
  }
  return null;
}

function tryPick(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(pickables, true);
  if (!hits.length) {
    hideInfo();
    return;
  }
  const target = pickFromObject(hits[0].object);
  if (!target) {
    hideInfo();
    return;
  }
  if (selected && selected !== target) setHighlight(selected, false);
  selected = target;
  setHighlight(target, true);
  showInfo(target.userData);
}

function pauseAutoRotate() {
  if (!controls) return;
  controls.autoRotate = false;
  window.clearTimeout(resumeTimer);
  resumeTimer = window.setTimeout(() => {
    controls.autoRotate = true;
  }, IDLE_RESUME_MS);
}

function setupInteraction() {
  const el = renderer.domElement;

  el.addEventListener('pointerdown', (e) => {
    pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
    pauseAutoRotate();
  });

  el.addEventListener('pointerup', (e) => {
    if (!pointerDown) return;
    const dx = e.clientX - pointerDown.x;
    const dy = e.clientY - pointerDown.y;
    const dt = performance.now() - pointerDown.t;
    pointerDown = null;
    if (dt < 700 && dx * dx + dy * dy < TAP_MOVE_PX * TAP_MOVE_PX) {
      tryPick(e.clientX, e.clientY);
    }
  });

  el.addEventListener('pointercancel', () => {
    pointerDown = null;
  });

  controls.addEventListener('start', pauseAutoRotate);
  controls.addEventListener('end', pauseAutoRotate);

  infoClose.addEventListener('click', (e) => {
    e.preventDefault();
    hideInfo();
  });

  // Expose helpers for headless screenshot verification.
  window.__ISS_PROJECT__ = (id) => {
    const obj = issGroup.getObjectByName(id);
    if (!obj) return null;
    const v = new THREE.Vector3();
    obj.getWorldPosition(v);
    v.project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
      visible: v.z < 1,
    };
  };
  window.__ISS_TAP_MODULE__ = (id) => {
    const obj = issGroup.getObjectByName(id);
    if (!obj) return false;
    if (selected && selected !== obj) setHighlight(selected, false);
    selected = obj;
    setHighlight(obj, true);
    showInfo(obj.userData);
    return true;
  };
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
}

function init() {
  initMaterials();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02010a);
  scene.fog = new THREE.FogExp2(0x02010a, 0.00045);

  camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.5, 2000);
  // Pulled back so a portrait phone can see the long truss and the 8 solar wings,
  // with Earth still along the lower edge of the frame.
  camera.position.set(112, 82, 148);

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x02010a, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  scene.add(new THREE.AmbientLight(0x8890a8, 0.42));
  const hemi = new THREE.HemisphereLight(0xc0d8ff, 0x1a2a50, 0.45);
  scene.add(hemi);

  sunLight = new THREE.DirectionalLight(0xfff2d8, 2.15);
  sunLight.position.set(140, 90, 70);
  scene.add(sunLight);
  scene.add(sunLight.target);

  // faint Earth shine from below
  const bounce = new THREE.DirectionalLight(0x6ea4ff, 0.35);
  bounce.position.set(0, -80, 0);
  scene.add(bounce);

  const sunBody = new THREE.Mesh(
    new THREE.SphereGeometry(6, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff4cc }),
  );
  sunBody.position.copy(sunLight.position).multiplyScalar(4);
  scene.add(sunBody);

  scene.add(buildStars());
  earthGroup = buildEarth();
  scene.add(earthGroup);

  issGroup = buildISS();
  scene.add(issGroup);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.45;
  controls.minDistance = 25;
  controls.maxDistance = 280;
  controls.target.set(5, 2, 0);
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.6;
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_PAN,
  };

  setupInteraction();
  window.addEventListener('resize', onResize);

  onResize();
  renderer.compile(scene, camera);
  renderer.render(scene, camera);
  loadingEl.classList.add('hide');
  window.setTimeout(() => loadingEl.remove(), 400);
  window.__ISS_READY__ = true;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (earthGroup) earthGroup.rotation.y += dt * 0.015;
  controls.update();
  renderer.render(scene, camera);
}

init();
animate();
