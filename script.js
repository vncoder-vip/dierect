// Initialize Lucide Icons
lucide.createIcons();

const initialComments = [];
let activePreviewObjectUrl = null;

const COMMENT_EDITOR_STORAGE_KEY = 'directchat-comment-samples';

function loadStoredCommentSamples() {
  try {
    const storedComments = JSON.parse(localStorage.getItem(COMMENT_EDITOR_STORAGE_KEY) || 'null');
    if (!Array.isArray(storedComments)) return;

    const validComments = storedComments
      .slice(0, 10)
      .map((comment) => ({
        name: String(comment?.name || '').trim().slice(0, 32),
        text: String(comment?.text || '').trim().slice(0, 120)
      }))
      .filter((comment) => comment.name && comment.text);

    if (validComments.length) initialComments.splice(0, initialComments.length, ...validComments);
  } catch {
    // Use the built-in sample comments if browser storage is unavailable.
  }
}

loadStoredCommentSamples();

async function loadRemoteComments() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/comments', {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) return [];
    const comments = await response.json();
    return Array.isArray(comments)
      ? comments
        .map((comment) => ({
          name: String(comment?.name || '').trim().slice(0, 24),
          text: String(comment?.text || '').trim().slice(0, 120),
          storage_label: String(comment?.storage_label || (comment?.storage_id ? `Sanity #${comment.storage_id}` : '')).trim()
        }))
        .filter((comment) => comment.name && comment.text)
      : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeMediaPreview(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.href;
  } catch {
    return '';
  }
}

function revokeActivePreviewObjectUrl() {
  if (activePreviewObjectUrl) {
    URL.revokeObjectURL(activePreviewObjectUrl);
    activePreviewObjectUrl = null;
  }
}

function getSelectedMediaFile() {
  const fileInput = document.getElementById('media-file');
  return fileInput && fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
}

function inferMediaTypeFromFile(file) {
  if (!file) return '';
  if (file.type?.startsWith('image/')) return 'image';
  if (file.type?.startsWith('video/')) return 'video';
  const name = String(file.name || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name)) return 'image';
  if (/\.(mp4|webm|ogg|mov|m4v)$/i.test(name)) return 'video';
  return '';
}

async function saveCommentToDatabase(payload, isFormData = false) {
  try {
    const response = await fetch('/api/comments', {
      method: 'POST',
      headers: isFormData ? {} : { 'Content-Type': 'application/json' },
      body: isFormData ? payload : JSON.stringify(payload)
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// Three.js Engine Variables
let scene, camera, renderer;
let commentSprites = [];
let starfieldParticles;

// Hollywood Pure White Rim Black Hole Meshes
let blackHoleCore, photonRimSphere, gravitationalLensingAura;
let blackHoleGroup;

// Ultra Fast Spinning Pulsar Neutron Star Meshes
let neutronGroup, neutronCore, neutronAura, beamConeTop, beamConeBottom;

// Celestial audio: replace the previous track whenever focus changes.
const CELESTIAL_AUDIO_FILES = {
  mercury: 'mercury.mp3',
  earth: [
    'earth1.mp3',
    'earth2.mp3',
    'earth3.mp3',
    'earth4.mp3',
    'earth5.mp3'
  ],
  shared: 'venus.mp3',
  blackHole: 'blackhole.mp3',
  neutron: 'neutron.mp3'
};
const PLANET_AUDIO_FILES = {
  Mercury: CELESTIAL_AUDIO_FILES.mercury,
  Earth: CELESTIAL_AUDIO_FILES.earth,
  Venus: CELESTIAL_AUDIO_FILES.shared,
  Uranus: CELESTIAL_AUDIO_FILES.shared,
  Neptune: CELESTIAL_AUDIO_FILES.shared
};
const SILENT_CELESTIAL_TARGETS = new Set(['Jupiter', 'Mars', 'Saturn']);
let activeCelestialAudio = null;
let earthAudioIndex = 0;

function playCelestialAudio(targetName) {
  if (SILENT_CELESTIAL_TARGETS.has(targetName)) {
    stopCelestialAudio();
    return;
  }

  let fileName = PLANET_AUDIO_FILES[targetName] || CELESTIAL_AUDIO_FILES.shared;
  if (Array.isArray(fileName)) {
    const earthTracks = fileName;
    fileName = earthTracks[earthAudioIndex];
    earthAudioIndex = (earthAudioIndex + 1) % earthTracks.length;
  }
  if (targetName.toLowerCase().includes('black hole')) {
    fileName = CELESTIAL_AUDIO_FILES.blackHole;
  } else if (targetName.toLowerCase().includes('neutron')) {
    fileName = CELESTIAL_AUDIO_FILES.neutron;
  }

  if (activeCelestialAudio) {
    activeCelestialAudio.pause();
    activeCelestialAudio.currentTime = 0;
  }

  try {
    const audioUrl = new URL(fileName, location.origin + '/').href;
    activeCelestialAudio = new Audio(audioUrl);
    activeCelestialAudio.preload = 'auto';
    activeCelestialAudio.volume = 0.72;
    activeCelestialAudio.crossOrigin = 'anonymous';
    activeCelestialAudio.play().catch((err) => {
      console.warn('Celestial audio playback blocked or failed:', audioUrl, err);
    });
  } catch (err) {
    console.warn('Failed to create celestial audio for', fileName, err);
  }
}

function stopCelestialAudio() {
  if (!activeCelestialAudio) return;
  activeCelestialAudio.pause();
  activeCelestialAudio.currentTime = 0;
  activeCelestialAudio = null;
}

// Neutron Star Jet Particles
let jetParticleSystem = null;
const JET_COUNT = 320;
const jetData = [];

// ─── Solar System ────────────────────────────────────────────────────────────
let solarSystemGroup = null;
const solarPlanets   = [];

// Procedural deep-sky galaxy catalogue.
let galaxyEntries = [];
const galaxyNeutronStars = [];
const GALAXY_DATA = [
  { id: 'andromeda', name: 'Andromeda (M31)', position: [86, 34, -118], tilt: 0.42, focusDistance: 25, arms: 2, tint: 0x9cc7ff, warmCore: 0xffd49b, population: 10_000_000_000 },
  { id: 'milkyway', name: 'Milky Way', position: [-112, 48, -92], tilt: 0.12, focusDistance: 28, arms: 2, tint: 0x8bb8ff, warmCore: 0xffd9a8, population: 10_000_000_000 },
  { id: 'eye', name: 'Thiên hà Con Mắt (NGC 4435/4438)', position: [126, -30, -142], tilt: 0.58, focusDistance: 26, arms: 1, tint: 0xf1b6ff, warmCore: 0xffc7a0, population: 10_000_000_000 }
];

const SS_ORIGIN = new THREE.Vector3(-130, -55, -130);
const PLANET_DATA = [
  { name:'Mercury', dist: 2.0,  e:0.206, size:0.10, period: 0.241, color:0xa8a0a0, tilt:0.03 },
  { name:'Venus',   dist: 3.5,  e:0.007, size:0.18, period: 0.615, color:0xe8c87a, tilt:177.4 * Math.PI/180 },
  { name:'Earth',   dist: 4.8,  e:0.017, size:0.20, period: 1.000, color:0x3a7bd5, tilt:23.4  * Math.PI/180, hasMoon:true },
  { name:'Mars',    dist: 6.8,  e:0.093, size:0.13, period: 1.881, color:0xcc4422, tilt:25.2  * Math.PI/180 },
  { name:'Jupiter', dist:11.5,  e:0.049, size:0.55, period:11.86,  color:0xc8a070, tilt:3.1   * Math.PI/180 },
  { name:'Saturn',  dist:16.5,  e:0.057, size:0.46, period:29.46, rotationPeriod:0.444, tidalLocked:true, color:0xd4b896, tilt:26.7  * Math.PI/180, hasRings:true },
  { name:'Uranus',  dist:21.5,  e:0.046, size:0.30, period:84.01,  color:0x7de8e8, tilt:97.8  * Math.PI/180 },
  { name:'Neptune', dist:26.0,  e:0.010, size:0.29, period:164.8,  color:0x3355ee, tilt:28.3  * Math.PI/180 },
];

const container = document.getElementById('canvas-container');

// 360 Degree Interactive Orbit Controls Variables
let isMouseDown = false;
let previousMousePosition = { x: 0, y: 0 };
let targetRotationX = 0;
let targetRotationY = 0;
let currentRotationX = 0;
let currentRotationY = 0;

// Camera focus system
const FOCUS_BLACK_HOLE = 'blackhole';
const FOCUS_NEUTRON    = 'neutron';
const FOCUS_PLANET     = 'planet';
const FOCUS_GALAXY     = 'galaxy';
const FOCUS_SOLAR_SYSTEM = 'solar-system';
const FOCUS_FREE       = 'free';

let cameraFocusTarget = FOCUS_SOLAR_SYSTEM;
let cameraLookTarget    = new THREE.Vector3(0, 0, 0);
let cameraPositionTarget = new THREE.Vector3(0, 0, 52);
let cameraTransitioning = false;
let focusedPlanetEntry  = null;
let focusedGalaxyEntry  = null;

let cameraDistance = 50;

let raycaster;
let mouse = new THREE.Vector2();

// 1. Create Canvas Messenger Bubble Texture — supports multi-line text
function createMessengerBubbleCanvas(name, text, storageLabel = '') {
  const MAX_WIDTH = 800;
  const LINE_HEIGHT = 28;
  const PADDING_X = 24;
  const TEXT_START_Y = 96;
  const BUBBLE_MARGIN = 64;
  const BUBBLE_RADIUS = 28;
  const BUBBLE_MIN_HEIGHT = 142;

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = '500 21px "Plus Jakarta Sans", sans-serif';
  const maxTextWidth = MAX_WIDTH - BUBBLE_MARGIN * 2 - PADDING_X * 2;
  const displayText = storageLabel ? `${text}\n\n[${storageLabel}]` : text;
  const words = displayText.split(' ');
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word;
    if (measureCtx.measureText(testLine).width > maxTextWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);

  const textBlockHeight = Math.max(lines.length, 1) * LINE_HEIGHT;
  const bubbleHeight = Math.max(BUBBLE_MIN_HEIGHT, TEXT_START_Y + textBlockHeight + 20);
  const canvasHeight = bubbleHeight + 34;

  const canvas = document.createElement('canvas');
  canvas.width = MAX_WIDTH;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const bubbleX = BUBBLE_MARGIN, bubbleY = 14, bubbleWidth = MAX_WIDTH - BUBBLE_MARGIN * 2, radius = BUBBLE_RADIUS;

  const gradient = ctx.createLinearGradient(bubbleX, bubbleY, bubbleX + bubbleWidth, bubbleY + bubbleHeight);
  gradient.addColorStop(0, '#ec4899');
  gradient.addColorStop(1, '#8b5cf6');

  ctx.fillStyle = gradient;
  ctx.shadowColor = 'rgba(236, 72, 153, 0.45)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;

  ctx.beginPath();
  ctx.moveTo(bubbleX + radius, bubbleY);
  ctx.lineTo(bubbleX + bubbleWidth - radius, bubbleY);
  ctx.quadraticCurveTo(bubbleX + bubbleWidth, bubbleY, bubbleX + bubbleWidth, bubbleY + radius);
  ctx.lineTo(bubbleX + bubbleWidth, bubbleY + bubbleHeight - radius);
  ctx.quadraticCurveTo(bubbleX + bubbleWidth, bubbleY + bubbleHeight, bubbleX + bubbleWidth - radius, bubbleY + bubbleHeight);
  ctx.lineTo(bubbleX + radius, bubbleY + bubbleHeight);
  ctx.quadraticCurveTo(bubbleX, bubbleY + bubbleHeight, bubbleX, bubbleY + bubbleHeight - 6);
  ctx.lineTo(bubbleX, bubbleY + radius);
  ctx.quadraticCurveTo(bubbleX, bubbleY, bubbleX + radius, bubbleY);
  ctx.closePath();
  ctx.fill();

  ctx.shadowColor = 'transparent';

  const avatarRadius = 24, avatarX = 30, avatarY = bubbleY + bubbleHeight - avatarRadius;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#e2e8f0';
  ctx.stroke();

  const initialLetter = name ? name.charAt(0).toUpperCase() : 'C';
  ctx.font = 'bold 20px "Plus Jakarta Sans", sans-serif';
  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initialLetter, avatarX, avatarY);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 23px "Plus Jakarta Sans", sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
  ctx.fillText(name, bubbleX + PADDING_X, bubbleY + 46);

  ctx.font = '500 21px "Plus Jakarta Sans", sans-serif';
  ctx.fillStyle = '#ffffff';
  lines.forEach((line, i) => {
    ctx.fillText(line, bubbleX + PADDING_X, bubbleY + TEXT_START_Y + i * LINE_HEIGHT);
  });

  return canvas;
}

// 2. Build Distant Starfield
function createStarfield() {
  const starCount = 3500;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);

  for (let i = 0; i < starCount; i++) {
    const r = 120 + Math.random() * 350;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    const colorType = Math.random();
    if (colorType > 0.8) {
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 0.7;
    } else if (colorType > 0.6) {
      colors[i * 3] = 0.8; colors[i * 3 + 1] = 0.9; colors[i * 3 + 2] = 1.0;
    } else {
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 1.0; colors[i * 3 + 2] = 1.0;
    }
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const starCanvas = document.createElement('canvas');
  starCanvas.width = 32; starCanvas.height = 32;
  const sCtx = starCanvas.getContext('2d');
  const sGrad = sCtx.createRadialGradient(16, 16, 0, 16, 16, 16);
  sGrad.addColorStop(0, 'rgba(255,255,255,1)');
  sGrad.addColorStop(0.4, 'rgba(255,255,255,0.8)');
  sGrad.addColorStop(1, 'rgba(255,255,255,0)');
  sCtx.fillStyle = sGrad;
  sCtx.fillRect(0, 0, 32, 32);

  const starTexture = new THREE.CanvasTexture(starCanvas);

  const material = new THREE.PointsMaterial({
    size: 1.4,
    map: starTexture,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false
  });

  starfieldParticles = new THREE.Points(geometry, material);
  scene.add(starfieldParticles);
}

// 3. Build Pure White Rim Black Hole
function createHollywoodBlackHole() {
  blackHoleGroup = new THREE.Group();

  const schwarzschildRadius = 7.8;

  const coreGeo = new THREE.SphereGeometry(schwarzschildRadius, 64, 64);
  const coreMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  blackHoleCore = new THREE.Mesh(coreGeo, coreMat);
  blackHoleGroup.add(blackHoleCore);

  const rimGeo = new THREE.SphereGeometry(schwarzschildRadius * 1.5, 128, 96);
  const rimMat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {},
    vertexShader: `
      varying vec3 vRimNormal;
      varying vec3 vRimViewDirection;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vRimNormal = normalize(normalMatrix * normal);
        vRimViewDirection = normalize(-viewPosition.xyz);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vRimNormal;
      varying vec3 vRimViewDirection;
      void main() {
        float edge = pow(1.0 - max(dot(normalize(vRimNormal), normalize(vRimViewDirection)), 0.0), 2.35);
        vec3 ivory = vec3(1.0, 0.985, 0.90);
        vec3 paleGold = vec3(1.0, 0.70, 0.28);
        vec3 rimColor = mix(ivory, paleGold, edge * 0.72);
        gl_FragColor = vec4(rimColor, edge * 1.15);
      }
    `
  });
  photonRimSphere = new THREE.Mesh(rimGeo, rimMat);
  blackHoleGroup.add(photonRimSphere);

  const auraGeo = new THREE.SphereGeometry(schwarzschildRadius * 1.86, 96, 64);
  const auraCanvas = document.createElement('canvas');
  auraCanvas.width = 256; auraCanvas.height = 256;
  const aCtx = auraCanvas.getContext('2d');
  const aGrad = aCtx.createRadialGradient(128, 128, 90, 128, 128, 128);
  aGrad.addColorStop(0, 'rgba(255, 255, 248, 0.96)');
  aGrad.addColorStop(0.34, 'rgba(255, 250, 226, 0.55)');
  aGrad.addColorStop(0.62, 'rgba(244, 218, 155, 0.22)');
  aGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  aCtx.fillStyle = aGrad;
  aCtx.fillRect(0, 0, 256, 256);

  const auraTexture = new THREE.CanvasTexture(auraCanvas);
  const auraMat = new THREE.MeshBasicMaterial({
    map: auraTexture,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide
  });
  gravitationalLensingAura = new THREE.Mesh(auraGeo, auraMat);
  blackHoleGroup.add(gravitationalLensingAura);

  const diskLayers = [
    { inner: schwarzschildRadius * 1.62, outer: schwarzschildRadius * 2.0, color: 0xfffff5, opacity: 0.98 },
    { inner: schwarzschildRadius * 2.02, outer: schwarzschildRadius * 2.46, color: 0xffedb96a, opacity: 0.58 },
    { inner: schwarzschildRadius * 2.5, outer: schwarzschildRadius * 3.35, color: 0xd9ae65, opacity: 0.22 }
  ];
  diskLayers.forEach((layer, index) => {
    const disk = new THREE.Mesh(
      new THREE.RingGeometry(layer.inner, layer.outer, 128),
      new THREE.MeshBasicMaterial({
        color: layer.color,
        transparent: true,
        opacity: layer.opacity,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    disk.rotation.x = Math.PI / 2;
    disk.rotation.z = index * 0.08;
    disk.userData.diskLayer = true;
    blackHoleGroup.add(disk);
  });
  blackHoleGroup.userData.accretionDisk = true;

  blackHoleGroup.scale.setScalar(1.45);

  scene.add(blackHoleGroup);
  return blackHoleGroup;
}

// 4. Build Ultra-Fast Spinning Pulsar Neutron Star in Far Distance
function createDistantNeutronStar() {
  neutronGroup = new THREE.Group();
  neutronGroup.position.set(55, 32, -65);

  const nCoreGeo = new THREE.SphereGeometry(1.6, 32, 32);
  const nCoreMat = new THREE.MeshBasicMaterial({ color: 0x60a5fa });
  neutronCore = new THREE.Mesh(nCoreGeo, nCoreMat);
  neutronGroup.add(neutronCore);

  const nAuraGeo = new THREE.SphereGeometry(2.4, 32, 32);
  const nAuraMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide
  });
  neutronAura = new THREE.Mesh(nAuraGeo, nAuraMat);
  neutronGroup.add(neutronAura);

  [2.0, 2.35, 2.7].forEach((radius, index) => {
    const fieldRing = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.035 + index * 0.018, 8, 64),
      new THREE.MeshBasicMaterial({
        color: index === 0 ? 0xffffff : 0x38bdf8,
        transparent: true,
        opacity: 0.72 - index * 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    fieldRing.rotation.x = Math.PI / 2;
    fieldRing.rotation.z = index * 0.48;
    neutronGroup.add(fieldRing);
  });

  [
    { x: 0.9, y: 0.75, z: 1.15 },
    { x: -0.75, y: -0.9, z: 1.05 }
  ].forEach((spot) => {
    const hotSpot = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending
      })
    );
    hotSpot.position.set(spot.x, spot.y, spot.z);
    neutronGroup.add(hotSpot);
  });

  const BEAM_LENGTH = 600;
  const BEAM_OFFSET = BEAM_LENGTH / 2;

  const matCore = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide
  });
  const matGlow = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide
  });
  const matHaze = new THREE.MeshBasicMaterial({
    color: 0x0ea5e9,
    transparent: true, opacity: 0.10,
    blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide
  });

  function makeThinBeam(yDir) {
    const group = new THREE.Group();
    group.position.y = yDir * BEAM_OFFSET;
    group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, BEAM_LENGTH, 8, 1, false), matCore));
    group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, BEAM_LENGTH, 8, 1, false), matGlow));
    group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, BEAM_LENGTH, 8, 1, false), matHaze));
    return group;
  }

  beamConeTop    = makeThinBeam(+1);
  beamConeBottom = makeThinBeam(-1);
  neutronGroup.add(beamConeTop);
  neutronGroup.add(beamConeBottom);

  scene.add(neutronGroup);
  createNeutronJetParticles();
}

function createNeutronJetParticles() {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(JET_COUNT * 3);
  const colors    = new Float32Array(JET_COUNT * 3);
  const sizes     = new Float32Array(JET_COUNT);

  const ptCanvas = document.createElement('canvas');
  ptCanvas.width = 32; ptCanvas.height = 32;
  const ptCtx = ptCanvas.getContext('2d');
  const ptGrad = ptCtx.createRadialGradient(16, 16, 0, 16, 16, 16);
  ptGrad.addColorStop(0,   'rgba(255,255,255,1)');
  ptGrad.addColorStop(0.3, 'rgba(147,210,255,0.9)');
  ptGrad.addColorStop(0.7, 'rgba(56,189,248,0.4)');
  ptGrad.addColorStop(1,   'rgba(0,0,0,0)');
  ptCtx.fillStyle = ptGrad;
  ptCtx.fillRect(0, 0, 32, 32);
  const ptTex = new THREE.CanvasTexture(ptCanvas);

  for (let i = 0; i < JET_COUNT; i++) {
    positions[i * 3]     = 0;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = 0;
    colors[i * 3]     = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1;
    sizes[i] = 0;

    jetData.push({
      pole:      i % 2 === 0 ? 1 : -1,
      life:      Math.random(),
      maxLife:   0.6 + Math.random() * 0.8,
      speed:     0.55 + Math.random() * 0.55,
      radialOff: (Math.random() - 0.5) * 0.02,
      pos:       new THREE.Vector3()
    });
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size',     new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.PointsMaterial({
    size: 0.55,
    map: ptTex,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true
  });

  jetParticleSystem = new THREE.Points(geo, mat);
  scene.add(jetParticleSystem);
}

function updateJetParticles() {
  if (!jetParticleSystem || !neutronGroup) return;

  const nsWorldPos = new THREE.Vector3();
  neutronGroup.getWorldPosition(nsWorldPos);

  const beamAxis = new THREE.Vector3(0, 1, 0);
  beamAxis.applyQuaternion(neutronGroup.quaternion).normalize();

  const posAttr  = jetParticleSystem.geometry.attributes.position;
  const colAttr  = jetParticleSystem.geometry.attributes.color;
  const sizeAttr = jetParticleSystem.geometry.attributes.size;

  for (let i = 0; i < JET_COUNT; i++) {
    const d = jetData[i];
    d.life += 0.016 / d.maxLife;

    if (d.life >= 1.0) {
      d.life = 0;
      d.speed   = 0.55 + Math.random() * 0.55;
      d.maxLife = 0.6  + Math.random() * 0.8;
      d.radialOff = (Math.random() - 0.5) * 0.02;
      d.pos.copy(nsWorldPos);
    }

    const dist = d.life * d.maxLife * d.speed * 42;

    const perpA = new THREE.Vector3(beamAxis.z, 0, -beamAxis.x).normalize();
    if (perpA.lengthSq() < 0.001) perpA.set(1, 0, 0);

    const jetPos = nsWorldPos.clone()
      .addScaledVector(beamAxis, d.pole * dist)
      .addScaledVector(perpA, d.radialOff * dist * 0.08);

    posAttr.setXYZ(i, jetPos.x, jetPos.y, jetPos.z);

    const t = d.life;
    const r = 1.0 - t * 0.5;
    const g = 1.0 - t * 0.35;
    const b = 1.0;
    colAttr.setXYZ(i, r, g, b);

    sizeAttr.setX(i, (1.0 - t) * 1.2 + 0.15);
  }

  posAttr.needsUpdate  = true;
  colAttr.needsUpdate  = true;
  sizeAttr.needsUpdate = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SOLAR SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
function createSolarSystem() {
  solarSystemGroup = new THREE.Group();
  solarSystemGroup.position.copy(SS_ORIGIN);
  scene.add(solarSystemGroup);

  const sunLight = new THREE.PointLight(0xffffff, 3.2, 260, 1.6);
  sunLight.position.copy(SS_ORIGIN);
  scene.add(sunLight);

  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xffee88 })
  );
  solarSystemGroup.add(sunMesh);

  const sunGlow1 = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 32, 32),
    new THREE.MeshBasicMaterial({ color:0xffaa22, transparent:true, opacity:0.25,
      blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.BackSide })
  );
  solarSystemGroup.add(sunGlow1);

  const sunGlow2 = new THREE.Mesh(
    new THREE.SphereGeometry(2.6, 32, 32),
    new THREE.MeshBasicMaterial({ color:0xff7700, transparent:true, opacity:0.08,
      blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.BackSide })
  );
  solarSystemGroup.add(sunGlow2);

  const beltCount = 800;
  const beltGeo   = new THREE.BufferGeometry();
  const beltPos   = new Float32Array(beltCount * 3);
  for (let i = 0; i < beltCount; i++) {
    const r     = 8.4 + Math.random() * 2.2;
    const angle = Math.random() * Math.PI * 2;
    const y     = (Math.random() - 0.5) * 0.4;
    beltPos[i*3]   = Math.cos(angle) * r;
    beltPos[i*3+1] = y;
    beltPos[i*3+2] = Math.sin(angle) * r;
  }
  beltGeo.setAttribute('position', new THREE.BufferAttribute(beltPos, 3));
  const beltMat = new THREE.PointsMaterial({
    size:0.06, color:0x887766,
    transparent:true, opacity:0.55, depthWrite:false
  });
  solarSystemGroup.add(new THREE.Points(beltGeo, beltMat));

  function drawOrbit(a, ecc, color) {
    const b  = a * Math.sqrt(1 - ecc * ecc);
    const cx = a * ecc;
    const pts = [];
    const SEG = 256;
    for (let i = 0; i <= SEG; i++) {
      const θ = (i / SEG) * Math.PI * 2;
      pts.push(new THREE.Vector3(
        a  * Math.cos(θ) - cx,
        0,
        b  * Math.sin(θ)
      ));
    }
    const geo  = new THREE.BufferGeometry().setFromPoints(pts);
    const mat  = new THREE.LineBasicMaterial({
      color, transparent:true, opacity:0.22,
      blending:THREE.AdditiveBlending, depthWrite:false
    });
    return new THREE.LineLoop(geo, mat);
  }

  function makePlanetMesh(pd) {
    const pc = document.createElement('canvas');
    pc.width = 256; pc.height = 128;
    const px = pc.getContext('2d');
    const r = (pd.color >> 16) & 0xff;
    const g = (pd.color >>  8) & 0xff;
    const b =  pd.color        & 0xff;

    let seed = pd.color ^ pd.name.length * 997;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const hashNoise = (x, y) => {
      const value = Math.sin(x * 127.1 + y * 311.7 + seed * 0.0001) * 43758.5453;
      return value - Math.floor(value);
    };
    const smoothNoise = (x, y) => {
      const x0 = Math.floor(x); const y0 = Math.floor(y);
      const tx = x - x0; const ty = y - y0;
      const sx = tx * tx * (3 - 2 * tx); const sy = ty * ty * (3 - 2 * ty);
      const n0 = hashNoise(x0, y0) * (1 - sx) + hashNoise(x0 + 1, y0) * sx;
      const n1 = hashNoise(x0, y0 + 1) * (1 - sx) + hashNoise(x0 + 1, y0 + 1) * sx;
      return n0 * (1 - sy) + n1 * sy;
    };
    const fbm = (x, y) => (
      smoothNoise(x, y) * 0.55 +
      smoothNoise(x * 2.1, y * 2.1) * 0.3 +
      smoothNoise(x * 4.4, y * 4.4) * 0.15
    );

    const pixels = px.createImageData(256, 128);
    const isGasGiant = pd.name === 'Jupiter' || pd.name === 'Saturn';
    for (let y = 0; y < 128; y++) {
      const latitude = y / 127;
      for (let x = 0; x < 256; x++) {
        const terrain = fbm(x / 34, y / 26);
        const bandFlow = Math.sin(latitude * Math.PI * (isGasGiant ? 18 : 8) + terrain * 2.4) * 0.05;
        const poleShade = 1 - Math.abs(latitude - 0.5) * 0.18;
        const contrast = poleShade * (isGasGiant ? 0.82 + terrain * 0.3 + bandFlow : 0.78 + terrain * 0.38);
        const offset = (y * 256 + x) * 4;
        pixels.data[offset] = Math.max(0, Math.min(255, Math.round(r * contrast)));
        pixels.data[offset + 1] = Math.max(0, Math.min(255, Math.round(g * contrast)));
        pixels.data[offset + 2] = Math.max(0, Math.min(255, Math.round(b * contrast)));
        pixels.data[offset + 3] = 255;
      }
    }
    px.putImageData(pixels, 0, 0);

    const bandCount = pd.name === 'Jupiter' || pd.name === 'Saturn' ? 18 : 10;
    for (let i = 0; i < bandCount; i++) {
      const y = (i / bandCount) * 128 + (random() - 0.5) * 5;
      const bandHeight = 3 + random() * (pd.name === 'Jupiter' || pd.name === 'Saturn' ? 8 : 4);
      px.fillStyle = `rgba(255,255,255,${0.035 + random() * 0.08})`;
      px.fillRect(0, y, 256, bandHeight);
    }

    if (pd.name === 'Earth') {
      px.fillStyle = 'rgba(39, 116, 74, 0.72)';
      for (let i = 0; i < 9; i++) {
        const cx = 20 + random() * 220;
        const cy = 25 + random() * 78;
        const rx = 8 + random() * 18;
        const ry = 4 + random() * 12;
        px.beginPath();
        for (let point = 0; point <= 12; point++) {
          const angle = (point / 12) * Math.PI * 2;
          const radius = 0.72 + random() * 0.42;
          const x = cx + Math.cos(angle) * rx * radius;
          const y = cy + Math.sin(angle) * ry * radius;
          if (point === 0) px.moveTo(x, y); else px.lineTo(x, y);
        }
        px.closePath();
        px.fill();
      }
      px.fillStyle = 'rgba(255,255,255,0.4)';
      for (let i = 0; i < 12; i++) {
        px.fillRect(random() * 210, 14 + random() * 100, 20 + random() * 32, 1.5 + random() * 2);
      }
    } else if (pd.name === 'Jupiter' || pd.name === 'Saturn') {
      px.fillStyle = pd.name === 'Jupiter' ? 'rgba(164,75,48,0.62)' : 'rgba(126,82,49,0.38)';
      for (let i = 0; i < 4; i++) {
        px.beginPath();
        px.ellipse(35 + random() * 190, 16 + random() * 95, 10 + random() * 16, 3 + random() * 6, 0, 0, Math.PI * 2);
        px.fill();
      }
      px.strokeStyle = pd.name === 'Jupiter' ? 'rgba(255,220,177,0.2)' : 'rgba(255,238,204,0.16)';
      px.lineWidth = 1.2;
      for (let i = 0; i < 24; i++) {
        const y = 8 + random() * 112;
        const start = random() * 230;
        px.beginPath();
        px.moveTo(start, y);
        px.bezierCurveTo(start + 8, y - 3, start + 18, y + 3, start + 32, y + (random() - 0.5) * 4);
        px.stroke();
      }
    } else if (pd.name === 'Mercury' || pd.name === 'Mars' || pd.name === 'Moon') {
      const drawCrater = (x, y, radius) => {
        const floor = px.createRadialGradient(x - radius * 0.25, y - radius * 0.3, radius * 0.1, x, y, radius);
        const isMars = pd.name === 'Mars';
        floor.addColorStop(0, isMars ? 'rgba(74,25,18,0.56)' : 'rgba(30,30,32,0.52)');
        floor.addColorStop(0.72, isMars ? 'rgba(100,34,24,0.32)' : 'rgba(70,70,72,0.3)');
        floor.addColorStop(1, 'rgba(255,255,255,0)');
        px.fillStyle = floor;
        px.beginPath();
        px.ellipse(x, y, radius, radius * (0.7 + random() * 0.25), random() * 0.5, 0, Math.PI * 2);
        px.fill();
        px.strokeStyle = isMars ? 'rgba(245,175,135,0.42)' : 'rgba(225,225,215,0.36)';
        px.lineWidth = Math.max(0.7, radius * 0.12);
        px.beginPath();
        px.arc(x - radius * 0.18, y - radius * 0.18, radius * 0.86, Math.PI * 0.95, Math.PI * 2.05);
        px.stroke();
      };
      for (let i = 0; i < 30; i++) {
        const x = random() * 256;
        const y = 8 + random() * 112;
        drawCrater(x, y, 1.2 + random() * 5.2);
      }
      if (pd.name === 'Mars') {
        px.fillStyle = 'rgba(245,230,210,0.42)';
        px.fillRect(0, 0, 256, 6);
        px.fillRect(0, 122, 256, 6);
      }
    } else {
      px.fillStyle = 'rgba(10,20,80,0.18)';
      for (let i = 0; i < 5; i++) {
        px.beginPath();
        px.ellipse(random() * 256, 12 + random() * 104, 8 + random() * 14, 2 + random() * 4, 0, 0, Math.PI * 2);
        px.fill();
      }
    }

    px.globalAlpha = 0.18;
    px.fillStyle = '#ffffff';
    px.fillRect(0, 0, 256, 7);
    px.fillRect(0, 121, 256, 7);
    const tex  = new THREE.CanvasTexture(pc);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(pd.size, 20, 20),
      new THREE.MeshPhongMaterial({
        map: tex,
        shininess: pd.name === 'Earth' || pd.name === 'Venus' ? 20 : 5,
        specular: pd.name === 'Earth' ? 0x6688aa : 0x222222
      })
    );
    mesh.rotation.z = pd.tilt || 0;

    const atmosphereColors = {
      Earth: 0x60a5fa,
      Mars: 0xf97316,
      Venus: 0xfbbf24,
      Uranus: 0x67e8f9,
      Neptune: 0x3b82f6
    };
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(pd.size * 1.08, 20, 20),
      new THREE.MeshBasicMaterial({
        color: atmosphereColors[pd.name] || 0xffffff,
        transparent: true,
        opacity: pd.name === 'Earth' || pd.name === 'Neptune' ? 0.18 : 0.1,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false
      })
    );
    mesh.add(atmosphere);
    return mesh;
  }

  const BASE_SPEED = 0.008;

  PLANET_DATA.forEach((pd) => {
    const a  = pd.dist;
    const e  = pd.e;
    const b  = a * Math.sqrt(1 - e * e);
    const cx = a * e;

    const mesh = makePlanetMesh(pd);
    solarSystemGroup.add(mesh);

    const entry = {
      mesh,
      name: pd.name,
      size: pd.size,
      a, b, cx,
      orbitAngle: Math.random() * Math.PI * 2,
      orbitSpeed: BASE_SPEED / pd.period,
      selfSpin:   pd.name === 'Saturn' ? 0.004 / pd.rotationPeriod : 0.02 + Math.random() * 0.01,
      moonMesh:   null,
      moonAngle:  Math.random() * Math.PI * 2,
    };

    mesh.userData.planetEntry = entry;

    const hitboxRadius = Math.max(pd.size * 6, 1.2);
    const hitbox = new THREE.Mesh(
      new THREE.SphereGeometry(hitboxRadius, 8, 8),
      new THREE.MeshBasicMaterial({ visible: false, depthWrite: false })
    );
    hitbox.userData.planetEntry = entry;
    mesh.add(hitbox);

    if (pd.hasRings) {
      const ringA = new THREE.Mesh(
        new THREE.RingGeometry(pd.size * 1.4, pd.size * 2.2, 80),
        new THREE.MeshBasicMaterial({
          color:0xd4c4a0, side:THREE.DoubleSide,
          transparent:true, opacity:0.60,
          blending:THREE.AdditiveBlending, depthWrite:false
        })
      );
      ringA.rotation.x = Math.PI / 2;
      mesh.add(ringA);

      const ringB = new THREE.Mesh(
        new THREE.RingGeometry(pd.size * 2.3, pd.size * 2.8, 80),
        new THREE.MeshBasicMaterial({
          color:0xc0aa88, side:THREE.DoubleSide,
          transparent:true, opacity:0.28,
          blending:THREE.AdditiveBlending, depthWrite:false
        })
      );
      ringB.rotation.x = Math.PI / 2;
      mesh.add(ringB);

      [0.9, 1.15, 1.42].forEach((scale, index) => {
        const detailRing = new THREE.Mesh(
          new THREE.RingGeometry(pd.size * scale, pd.size * (scale + 0.055), 96),
          new THREE.MeshBasicMaterial({
            color: index === 1 ? 0xf7e7bf : 0xa68d68,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.38 - index * 0.07,
            blending: THREE.AdditiveBlending,
            depthWrite: false
          })
        );
        detailRing.rotation.x = Math.PI / 2;
        mesh.add(detailRing);
      });
    }

    if (pd.hasMoon) {
      const moonMesh = makePlanetMesh({ name: 'Moon', size: 0.055, color: 0xb8b8b2, tilt: 0 });
      solarSystemGroup.add(moonMesh);
      entry.moonMesh = moonMesh;
    }

    solarPlanets.push(entry);
  });
}

// Build a stylised but recognisable deep-sky galaxy from stars, dust and glow.
function createGalaxies() {
  const makeGlowTexture = (coreColor) => {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const color = new THREE.Color(coreColor);
    const rgb = `${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)}`;
    const gradient = ctx.createRadialGradient(128, 128, 4, 128, 128, 128);
    gradient.addColorStop(0, 'rgba(255,255,255,0.98)');
    gradient.addColorStop(0.14, `rgba(${rgb},0.82)`);
    gradient.addColorStop(0.48, `rgba(${rgb},0.2)`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(canvas);
  };

  const addCentralBlackHole = (parent, scale = 1, accent = 0xfff1c7) => {
    const blackHole = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.72 * scale, 24, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    blackHole.add(core);

    const photonRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.05 * scale, 0.075 * scale, 10, 64),
      new THREE.MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.94,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    photonRing.rotation.x = Math.PI / 2;
    blackHole.add(photonRing);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.34 * scale, 24, 20),
      new THREE.MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false
      })
    );
    blackHole.add(halo);
    parent.add(blackHole);
  };

  const addGalaxyNeutronStar = (parent, position, scale = 1) => {
    const neutronStar = new THREE.Group();
    neutronStar.position.set(...position);
    neutronStar.userData.galaxyNeutronStar = true;

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.58 * scale, 24, 20),
      new THREE.MeshBasicMaterial({ color: 0xf4fbff })
    );
    neutronStar.add(core);

    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(0.95 * scale, 24, 20),
      new THREE.MeshBasicMaterial({
        color: 0x39bdf8,
        transparent: true,
        opacity: 0.28,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false
      })
    );
    neutronStar.add(aura);
    neutronStar.userData.aura = aura;

    [0.78, 1.0, 1.22].forEach((radius, index) => {
      const magneticLoop = new THREE.Mesh(
        new THREE.TorusGeometry(radius * scale, (0.025 + index * 0.008) * scale, 8, 48),
        new THREE.MeshBasicMaterial({
          color: index === 1 ? 0xffffff : 0x76d8ff,
          transparent: true,
          opacity: 0.7 - index * 0.12,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      );
      magneticLoop.rotation.x = Math.PI / 2;
      magneticLoop.rotation.z = index * 0.24;
      neutronStar.add(magneticLoop);
    });

    [-1, 1].forEach((direction) => {
      const jetGlow = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12 * scale, 0.035 * scale, 5.8 * scale, 10),
        new THREE.MeshBasicMaterial({
          color: 0x2d9cff,
          transparent: true,
          opacity: 0.22,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      );
      jetGlow.position.y = direction * 3.05 * scale;
      neutronStar.add(jetGlow);

      const jetCore = new THREE.Mesh(
        new THREE.CylinderGeometry(0.026 * scale, 0.008 * scale, 5.8 * scale, 8),
        new THREE.MeshBasicMaterial({
          color: 0xdff7ff,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      );
      jetCore.position.y = direction * 3.05 * scale;
      neutronStar.add(jetCore);
    });

    parent.add(neutronStar);
    galaxyNeutronStars.push(neutronStar);
  };

  const createDisk = (parent, config, seedOffset = 0, scale = 1, armCount = config.arms) => {
    let seed = 73129 + seedOffset * 991;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const starCount = Math.round(28000 * scale);
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const cool = new THREE.Color(config.tint);
    const warm = new THREE.Color(config.warmCore);
    const stellarPalette = [
      new THREE.Color(0x8fc9ff),
      new THREE.Color(0xc8e5ff),
      new THREE.Color(0xffffff),
      new THREE.Color(0xfff0bd),
      new THREE.Color(0xffbd72),
      new THREE.Color(0xff806e),
      new THREE.Color(0xe5a7ff)
    ];

    for (let i = 0; i < starCount; i++) {
      const radius = Math.sqrt(random()) * 32 * scale;
      const angle = random() * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const y = (random() - 0.5) * (0.9 + radius * 0.09);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      const paletteColor = stellarPalette[Math.floor(random() * stellarPalette.length)];
      const starColor = random() < 0.35 ? warm : (random() < 0.25 ? cool : paletteColor);
      const brightness = 0.4 + random() * 0.85;
      colors[i * 3] = Math.min(1, starColor.r * brightness);
      colors[i * 3 + 1] = Math.min(1, starColor.g * brightness);
      colors[i * 3 + 2] = Math.min(1, starColor.b * brightness);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const stars = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: 0.16,
      vertexColors: true,
      transparent: true,
      opacity: 0.86,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    }));
    parent.add(stars);

    const planetCount = Math.round(11000 * scale);
    const planetPositions = new Float32Array(planetCount * 3);
    const planetColors = new Float32Array(planetCount * 3);
    const planetPalette = [0x78a7ff, 0x66e0d1, 0xffc875, 0xff8fc4, 0xb99bff, 0xd9f3ff, 0xfff0a8];
    for (let i = 0; i < planetCount; i++) {
      const radius = Math.sqrt(random()) * 31 * scale;
      const angle = random() * Math.PI * 2;
      planetPositions[i * 3] = Math.cos(angle) * radius;
      planetPositions[i * 3 + 1] = (random() - 0.5) * (1.1 + radius * 0.1);
      planetPositions[i * 3 + 2] = Math.sin(angle) * radius;
      const planetColor = new THREE.Color(planetPalette[Math.floor(random() * planetPalette.length)]);
      const planetBrightness = 0.45 + random() * 0.65;
      planetColors[i * 3] = Math.min(1, planetColor.r * planetBrightness);
      planetColors[i * 3 + 1] = Math.min(1, planetColor.g * planetBrightness);
      planetColors[i * 3 + 2] = Math.min(1, planetColor.b * planetBrightness);
    }
    const planetGeometry = new THREE.BufferGeometry();
    planetGeometry.setAttribute('position', new THREE.BufferAttribute(planetPositions, 3));
    planetGeometry.setAttribute('color', new THREE.BufferAttribute(planetColors, 3));
    const planetMaterial = new THREE.PointsMaterial({
      vertexColors: true,
      size: 0.055,
      transparent: true,
      opacity: 0.34,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    parent.add(new THREE.Points(planetGeometry, planetMaterial));

    const bulge = new THREE.Mesh(
      new THREE.SphereGeometry(4.8 * scale, 24, 16),
      new THREE.MeshBasicMaterial({
        color: config.warmCore,
        transparent: true,
        opacity: 0.14,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    bulge.scale.y = 0.32;
    parent.add(bulge);

    const core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(config.warmCore),
      transparent: true,
      opacity: 0.82,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    }));
    core.scale.set(12 * scale, 7 * scale, 1);
    parent.add(core);
    addCentralBlackHole(parent, 0.92 * scale, config.warmCore);

    const dustPositions = new Float32Array(Math.round(starCount * 0.34) * 3);
    for (let i = 0; i < dustPositions.length; i += 3) {
      const radius = (0.35 + random() * 0.95) * 28 * scale;
      const angle = random() * Math.PI * 2 + radius * 0.34;
      dustPositions[i] = Math.cos(angle) * radius;
      dustPositions[i + 1] = (random() - 0.5) * 0.6;
      dustPositions[i + 2] = Math.sin(angle) * radius;
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
    parent.add(new THREE.Points(dustGeometry, new THREE.PointsMaterial({
      color: 0x19152a,
      size: 0.32,
      transparent: true,
      opacity: 0.3,
      depthWrite: false
    })));
  };

  GALAXY_DATA.forEach((config, index) => {
    const galaxyGroup = new THREE.Group();
    galaxyGroup.position.set(...config.position);
    galaxyGroup.rotation.x = config.tilt;
    galaxyGroup.rotation.z = index === 1 ? 0.22 : -0.18;
    galaxyGroup.userData.galaxyId = config.id;
    galaxyGroup.userData.galaxyName = config.name;
    createDisk(galaxyGroup, config, index);

    if (config.id === 'andromeda') {
      addGalaxyNeutronStar(galaxyGroup, [13.5, 0.85, -5.5], 1.08);
      [11, 17, 23].forEach((radius, ringIndex) => {
        const dustRing = new THREE.Mesh(
          new THREE.TorusGeometry(radius, 0.055 + ringIndex * 0.025, 8, 128),
          new THREE.MeshBasicMaterial({
            color: ringIndex === 1 ? 0x82baff : 0x536d9f,
            transparent: true,
            opacity: 0.18 - ringIndex * 0.035,
            blending: THREE.AdditiveBlending,
            depthWrite: false
          })
        );
        dustRing.rotation.x = Math.PI / 2;
        galaxyGroup.add(dustRing);
      });
    } else if (config.id === 'milkyway') {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(17, 0.32, 1.05),
        new THREE.MeshBasicMaterial({
          color: 0xf0c48a,
          transparent: true,
          opacity: 0.24,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      );
      galaxyGroup.add(bar);
      const barGlow = new THREE.Mesh(
        new THREE.BoxGeometry(19, 0.08, 1.8),
        new THREE.MeshBasicMaterial({
          color: 0x8bb8ff,
          transparent: true,
          opacity: 0.12,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      );
      galaxyGroup.add(barGlow);
    } else if (config.id === 'eye') {
      const eyeRing = new THREE.Mesh(
        new THREE.TorusGeometry(10.5, 0.09, 8, 128),
        new THREE.MeshBasicMaterial({
          color: 0xe2a8ff,
          transparent: true,
          opacity: 0.2,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      );
      eyeRing.rotation.x = Math.PI / 2;
      galaxyGroup.add(eyeRing);
    }

    if (config.id === 'eye') {
      const companion = new THREE.Group();
      companion.position.set(7.8, 0.7, 1.6);
      companion.rotation.z = 0.38;
      companion.scale.setScalar(0.52);
      createDisk(companion, { ...config, tint: 0xf7d4ff, warmCore: 0xffd6b0 }, 9, 0.68, 1);
      galaxyGroup.add(companion);

      const bridge = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.45, 8.5, 12),
        new THREE.MeshBasicMaterial({
          color: 0xb79ad6,
          transparent: true,
          opacity: 0.18,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      );
      bridge.rotation.z = Math.PI / 2;
      bridge.position.set(4, 0.2, 0.5);
      galaxyGroup.add(bridge);
    }

    scene.add(galaxyGroup);
    galaxyEntries.push({
      id: config.id,
      name: config.name,
      group: galaxyGroup,
      focusDistance: config.focusDistance,
      population: config.population
    });
  });
}

function updateSolarSystem(time) {
  if (!solarSystemGroup) return;

  solarPlanets.forEach((p) => {
    p.orbitAngle += p.orbitSpeed;

    const θ = p.orbitAngle;
    const lx = p.a * Math.cos(θ) - p.cx;
    const lz = p.b * Math.sin(θ);

    p.mesh.position.set(lx, 0, lz);
      if (p.tidalLocked) {
        p.mesh.rotation.y = p.orbitAngle;
      } else {
        p.mesh.rotation.y += p.selfSpin;
      }

    if (p.moonMesh) {
      p.moonAngle += 0.08;
      const mr = 0.52;
      p.moonMesh.position.set(
        lx + Math.cos(p.moonAngle) * mr,
        Math.sin(p.moonAngle * 0.5) * 0.08,
        lz + Math.sin(p.moonAngle) * mr
      );
    }
  });
}

async function initThree() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x030712, 0.003);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = cameraDistance;

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
  scene.add(ambientLight);

  raycaster = new THREE.Raycaster();

  createStarfield();
  createHollywoodBlackHole();
  createDistantNeutronStar();
  createSolarSystem();
  buildCommentQueue();
  setTimeout(startNextComment, 1000);

  // Do not hold WebGL setup, controls, or the first render hostage to a
  // serverless/API request. Comments are merged when the request completes.
  loadRemoteComments().then((remoteComments) => {
    if (!remoteComments.length) return;
    const hadComments = commentQueue.length > 0;
    initialComments.push(...remoteComments.slice(-12));
    buildCommentQueue();
    if (!hadComments) startNextComment();
  });

  currentRotationX = 0.52;
  targetRotationX = 0.52;
  currentRotationY = -0.62;
  targetRotationY = -0.62;

  setup360OrbitControls();
  setupClickDetection();
  setupTargetFinder();

  window.addEventListener('resize', onWindowResize);
  animate();
}

// Target finder UI
function setupTargetFinder() {
  const targetSelect = document.getElementById('celestial-target');
  const focusButton = document.getElementById('focus-target');
  const freeOrbitButton = document.getElementById('free-orbit');
  const toggleButton = document.getElementById('toggle-telescope');
  const targetFinder = document.querySelector('.target-finder');

  if (!targetSelect || !focusButton || !freeOrbitButton) return;

  if (toggleButton && targetFinder) {
    toggleButton.addEventListener('click', () => {
      const isHidden = targetFinder.style.display === 'none';
      targetFinder.style.display = isHidden ? '' : 'none';
      toggleButton.classList.toggle('active', isHidden);
    });
    targetFinder.style.display = 'none';
  }

  PLANET_DATA.forEach((planet) => {
    const option = document.createElement('option');
    option.value = `planet:${planet.name}`;
    option.textContent = planet.name;
    targetSelect.appendChild(option);
  });

  const focusSelectedTarget = () => {
    const target = targetSelect.value;
    if (target === FOCUS_BLACK_HOLE) {
      focusOnBlackHole();
    } else if (target === FOCUS_NEUTRON) {
      focusOnNeutronStar();
    } else if (target.startsWith('planet:')) {
      const planetName = target.slice('planet:'.length);
      const entry = solarPlanets.find((planet) => planet.name === planetName);
      if (entry) focusOnPlanet(entry);
    } else if (target.startsWith('galaxy:')) {
      const galaxyId = target.slice('galaxy:'.length);
      const entry = galaxyEntries.find((galaxy) => galaxy.id === galaxyId);
      if (entry) focusOnGalaxy(entry);
    }
  };

  focusButton.addEventListener('click', focusSelectedTarget);
  targetSelect.addEventListener('change', focusSelectedTarget);
  freeOrbitButton.addEventListener('click', () => {
    targetSelect.value = '';
    stopCelestialAudio();
    returnToFreeOrbit();
  });
}

function showFocusHint(objectName) {
  let hint = document.getElementById('focus-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'focus-hint';
    hint.style.cssText = `
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.75);
      color: #fff;
      font-family: 'Plus Jakarta Sans', sans-serif;
      font-size: 14px;
      padding: 10px 22px;
      border-radius: 99px;
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.15);
      z-index: 999;
      opacity: 0;
      transition: opacity 0.4s ease;
      pointer-events: none;
    `;
    document.body.appendChild(hint);
  }
  hint.innerText = `📷 Đang quan sát: ${objectName} — Click vào vùng trống để thoát`;
  hint.style.opacity = '1';
}

function hideFocusHint() {
  const hint = document.getElementById('focus-hint');
  if (hint) hint.style.opacity = '0';
}

function setupClickDetection() {
  renderer.domElement.addEventListener('click', onCanvasClick);
}

function onCanvasClick(event) {
  if (window._wasDragging) { window._wasDragging = false; return; }
  if (event.target.closest && event.target.closest('.navbar-container, .comment-card, button, a')) return;

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  scene.updateMatrixWorld(true);
  raycaster.setFromCamera(mouse, camera);

  const bhObjects = blackHoleGroup ? blackHoleGroup.children : [];
  if (raycaster.intersectObjects(bhObjects).length > 0) {
    focusOnBlackHole();
    return;
  }

  if (neutronGroup) {
    if (raycaster.intersectObjects(neutronGroup.children, true).length > 0) {
      focusOnNeutronStar();
      return;
    }
  }

  if (solarPlanets.length > 0) {
    const hits = raycaster.intersectObjects(solarPlanets.map(p => p.mesh), true);
    if (hits.length > 0) {
      let obj = hits[0].object;
      let found = null;
      while (obj) {
        if (obj.userData && obj.userData.planetEntry) {
          found = obj.userData.planetEntry;
          break;
        }
        obj = obj.parent;
      }
      if (found) {
        focusOnPlanet(found);
        return;
      }
    }
  }

  for (const galaxy of galaxyEntries) {
    if (raycaster.intersectObjects(galaxy.group.children, true).length > 0) {
      focusOnGalaxy(galaxy);
      return;
    }
  }

  if (cameraFocusTarget !== FOCUS_FREE) {
    returnToFreeOrbit();
  }
}

function focusOnBlackHole() {
  cameraFocusTarget = FOCUS_BLACK_HOLE;
  cameraTransitioning = true;
  playCelestialAudio('black hole');

  const dist = 38;
  const angle = Math.atan2(camera.position.z, camera.position.x);
  cameraPositionTarget.set(Math.cos(angle) * dist, 4, Math.sin(angle) * dist);
  cameraLookTarget.set(0, 0, 0);

  currentRotationX = 0;
  currentRotationY = Math.atan2(camera.position.x, camera.position.z);
  targetRotationX = 0;
  targetRotationY = currentRotationY;

  cameraDistance = dist;
  showFocusHint('Hố Đen');
}

function focusOnNeutronStar() {
  cameraFocusTarget = FOCUS_NEUTRON;
  cameraTransitioning = true;
  playCelestialAudio('neutron star');

  const nsPos = neutronGroup.position;
  const dist = 16;
  const dir = camera.position.clone().sub(nsPos).normalize();
  cameraPositionTarget.copy(nsPos).addScaledVector(dir, dist);
  cameraLookTarget.copy(nsPos);

  const relDir = camera.position.clone().sub(nsPos);
  currentRotationY = Math.atan2(relDir.x, relDir.z);
  currentRotationX = Math.asin(Math.max(-1, Math.min(1, relDir.y / relDir.length())));
  targetRotationY = currentRotationY;
  targetRotationX = currentRotationX;
  cameraDistance = dist;

  showFocusHint('Sao Neutron');
}

function returnToFreeOrbit() {
  cameraFocusTarget  = FOCUS_FREE;
  focusedPlanetEntry = null;
  focusedGalaxyEntry = null;
  cameraTransitioning = true;
  cameraDistance = 52;
  cameraLookTarget.set(0, 0, 0);

  currentRotationX = 0;
  currentRotationY = 0;
  targetRotationX  = 0;
  targetRotationY  = 0;

  hideFocusHint();
}

function focusOnPlanet(entry) {
  cameraFocusTarget  = FOCUS_PLANET;
  focusedPlanetEntry = entry;
  cameraTransitioning = true;
  playCelestialAudio(entry.name);

  cameraDistance = Math.max(3, entry.size * 12);

  const wPos = new THREE.Vector3();
  entry.mesh.getWorldPosition(wPos);

  const rel = camera.position.clone().sub(wPos);
  const relLen = rel.length();
  currentRotationY = Math.atan2(rel.x, rel.z);
  currentRotationX = Math.asin(Math.max(-1, Math.min(1, rel.y / (relLen || 1))));
  targetRotationY  = currentRotationY;
  targetRotationX  = currentRotationX;

  showFocusHint(entry.name);
}

function focusOnGalaxy(entry) {
  cameraFocusTarget = FOCUS_GALAXY;
  focusedGalaxyEntry = entry;
  focusedPlanetEntry = null;
  cameraTransitioning = true;
  stopCelestialAudio();
  cameraDistance = entry.focusDistance;

  const rel = camera.position.clone().sub(entry.group.position);
  const relLen = rel.length();
  currentRotationY = Math.atan2(rel.x, rel.z);
  currentRotationX = Math.asin(Math.max(-1, Math.min(1, rel.y / (relLen || 1))));
  targetRotationY = currentRotationY;
  targetRotationX = currentRotationX;
  cameraLookTarget.copy(entry.group.position);

  const populationLabel = entry.population ? ` · ~${(entry.population / 1_000_000_000).toFixed(0)} tỷ hệ sao` : '';
  showFocusHint(`${entry.name}${populationLabel}`);
}

function setup360OrbitControls() {
  let mouseDownPos = { x: 0, y: 0 };

  window.addEventListener('mousedown', (e) => {
    if (e.target.closest && (e.target.closest('.navbar-container') || e.target.closest('.comment-card') || e.target.closest('button') || e.target.closest('a'))) return;
    isMouseDown = true;
    mouseDownPos = { x: e.clientX, y: e.clientY };
    previousMousePosition = { x: e.clientX, y: e.clientY };
    document.body.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isMouseDown) return;

    const deltaX = e.clientX - previousMousePosition.x;
    const deltaY = e.clientY - previousMousePosition.y;

    targetRotationY -= deltaX * 0.006;
    targetRotationX += deltaY * 0.006;
    targetRotationX = Math.max(-Math.PI / 2.05, Math.min(Math.PI / 2.05, targetRotationX));

    previousMousePosition = { x: e.clientX, y: e.clientY };
  });

  window.addEventListener('mouseup', (e) => {
    const dx = Math.abs(e.clientX - mouseDownPos.x);
    const dy = Math.abs(e.clientY - mouseDownPos.y);
    window._wasDragging = (dx >= 5 || dy >= 5);
    isMouseDown = false;
    document.body.style.cursor = 'default';
  });

  window.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      if (e.target.closest && (e.target.closest('.navbar-container') || e.target.closest('.comment-card') || e.target.closest('button'))) return;
      isMouseDown = true;
      previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  });

  window.addEventListener('touchmove', (e) => {
    if (!isMouseDown || e.touches.length !== 1) return;
    const deltaX = e.touches[0].clientX - previousMousePosition.x;
    const deltaY = e.touches[0].clientY - previousMousePosition.y;

    targetRotationY -= deltaX * 0.006;
    targetRotationX += deltaY * 0.006;
    targetRotationX = Math.max(-Math.PI / 2.05, Math.min(Math.PI / 2.05, targetRotationX));

    previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  });

  window.addEventListener('touchend', () => { isMouseDown = false; });
}

// ─── Comment Queue System ────────────────────────────────────────────────────
// Shows one comment at a time: appears at outer orbit, spirals into black hole, disappears
let commentQueue = [];
let activeCommentIndex = -1;
let activeCommentNode = null;
let commentLifeTimer = 0;
const COMMENT_DURATION = 30; // seconds per comment — slow elliptical drift
const BH_RADIUS = 11; // event horizon visual radius (~7.8 * 1.45)
const ORBIT_START_RADIUS_A = BH_RADIUS + 22;
const ORBIT_START_RADIUS_B = BH_RADIUS + 14;

function buildCommentQueue() {
  commentQueue = initialComments.map((c, i) => ({ ...c, index: i }));
}

function startNextComment() {
  if (commentQueue.length === 0) return;

  // Remove previous sprite
  if (activeCommentNode && activeCommentNode.sprite) {
    scene.remove(activeCommentNode.sprite);
    activeCommentNode.sprite.material.map.dispose();
    activeCommentNode.sprite.material.dispose();
  }

  activeCommentIndex = (activeCommentIndex + 1) % commentQueue.length;
  const entry = commentQueue[activeCommentIndex];

  const canvas = createMessengerBubbleCanvas(entry.name, entry.text, entry.storage_label || '');
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({ 
    map: texture, 
    transparent: true,
    opacity: 1.0
  });

  const sprite = new THREE.Sprite(material);
  const canvasAspect = canvas.width / canvas.height;
  sprite.scale.set(canvasAspect * 3.2 * 1.35, 3.2 * 1.35, 1);

  const startAngle = Math.random() * Math.PI * 2;
  sprite.position.set(
    Math.cos(startAngle) * ORBIT_START_RADIUS_A,
    Math.sin(startAngle) * 3,
    Math.sin(startAngle) * ORBIT_START_RADIUS_B
  );

  scene.add(sprite);

  activeCommentNode = {
    sprite,
    angle: startAngle,
    startRadiusA: ORBIT_START_RADIUS_A,
    startRadiusB: ORBIT_START_RADIUS_B,
    orbitTilt: (Math.random() - 0.5) * 0.6
  };

  commentLifeTimer = 0;
  updateCommentCountDisplay();
}

function updateCommentCountDisplay() {
  const countElem = document.getElementById('comment-count');
  if (countElem) {
    const total = initialComments.length;
    countElem.innerText = `✨ ${total} lời nhắn đang bay vào Hố Đen`;
  }
}

function updateActiveComment(deltaTime) {
  if (!activeCommentNode) return;

  commentLifeTimer += deltaTime;
  const progress = Math.min(commentLifeTimer / COMMENT_DURATION, 1); // 0→1 over 30s

  // First 25 seconds (progress 0→0.833): orbit normally at full radius
  // Last 5 seconds (progress 0.833→1): spiral into the black hole
  const SPIRAL_START = 25 / 30; // ≈ 0.833
  let currentRadiusA, currentRadiusB, angle;

  if (progress < SPIRAL_START) {
    // Orbiting — stay at start radius, circle around
    currentRadiusA = activeCommentNode.startRadiusA;
    currentRadiusB = activeCommentNode.startRadiusB;
    angle = activeCommentNode.angle + progress * Math.PI * 1.8; // slow orbit
  } else {
    // Last 5 seconds — spiral in toward the black hole
    const spiralProgress = (progress - SPIRAL_START) / (1 - SPIRAL_START); // 0→1 over last 5s
    currentRadiusA = activeCommentNode.startRadiusA * (1 - spiralProgress);
    currentRadiusB = activeCommentNode.startRadiusB * (1 - spiralProgress);
    angle = activeCommentNode.angle + progress * Math.PI * 1.8 + spiralProgress * Math.PI * 3;
  }

  const x = Math.cos(angle) * currentRadiusA;
  const z = Math.sin(angle) * currentRadiusB;
  const y = Math.sin(angle * 2) * (2 + activeCommentNode.orbitTilt * 4) * (1 - progress * 0.5);

  activeCommentNode.sprite.position.x = x;
  activeCommentNode.sprite.position.y = y;
  activeCommentNode.sprite.position.z = z;

  // Full scale during orbit, shrink only in last 5 seconds
  let scaleFactor = 1;
  if (progress > SPIRAL_START) {
    const spiralProgress = (progress - SPIRAL_START) / (1 - SPIRAL_START);
    scaleFactor = 1 - spiralProgress * 0.7;
  }
  const baseW = activeCommentNode.sprite.scale.x;
  const baseH = activeCommentNode.sprite.scale.y;
  activeCommentNode.sprite.scale.set(baseW * scaleFactor, baseH * scaleFactor, 1);

  // Fade out only in the last 2 seconds
  const FADE_START = 28 / 30; // ≈ 0.933
  if (progress > FADE_START) {
    const fadeOut = 1 - (progress - FADE_START) / (1 - FADE_START);
    activeCommentNode.sprite.material.opacity = Math.max(0, fadeOut);
  } else {
    activeCommentNode.sprite.material.opacity = 1;
  }

  if (progress >= 1) {
    startNextComment();
  }
}

// 5. Render Loop
function animate() {
  requestAnimationFrame(animate);

  const time = Date.now() * 0.001;

  currentRotationX += (targetRotationX - currentRotationX) * 0.06;
  currentRotationY += (targetRotationY - currentRotationY) * 0.06;

  let orbitCenter = new THREE.Vector3(0, 0, 0);
  if (cameraFocusTarget === FOCUS_NEUTRON && neutronGroup) {
    orbitCenter.copy(neutronGroup.position);
  } else if (cameraFocusTarget === FOCUS_PLANET && focusedPlanetEntry) {
    focusedPlanetEntry.mesh.getWorldPosition(orbitCenter);
  } else if (cameraFocusTarget === FOCUS_GALAXY && focusedGalaxyEntry) {
    orbitCenter.copy(focusedGalaxyEntry.group.position);
  } else if (cameraFocusTarget === FOCUS_SOLAR_SYSTEM && solarSystemGroup) {
    orbitCenter.copy(solarSystemGroup.position);
  }

  const orbitX = cameraDistance * Math.sin(currentRotationY) * Math.cos(currentRotationX);
  const orbitY = cameraDistance * Math.sin(currentRotationX);
  const orbitZ = cameraDistance * Math.cos(currentRotationY) * Math.cos(currentRotationX);

  const desiredPos = new THREE.Vector3(
    orbitCenter.x + orbitX,
    orbitCenter.y + orbitY,
    orbitCenter.z + orbitZ
  );

  camera.position.lerp(desiredPos, 0.07);
  camera.lookAt(orbitCenter);

  if (starfieldParticles) starfieldParticles.rotation.y = time * 0.003;

  galaxyEntries.forEach((galaxy, index) => {
    galaxy.group.rotation.y += 0.00018 + index * 0.00004;
  });

  galaxyNeutronStars.forEach((star, index) => {
    star.rotation.y += 0.012;
    star.rotation.z = Math.sin(time * 3.2 + index) * 0.14;
    const pulse = 1 + Math.sin(time * 14 + index) * 0.1;
    if (star.userData.aura) star.userData.aura.scale.setScalar(pulse);
  });

  if (blackHoleGroup && blackHoleGroup.userData.accretionDisk) {
    blackHoleGroup.children.forEach((child) => {
      if (child.userData && child.userData.diskLayer) child.rotation.z += 0.003;
    });
  }

  if (neutronGroup) {
    neutronGroup.rotation.y += 0.8;
    neutronGroup.rotation.x = Math.sin(time * 25) * 0.45;
    neutronGroup.rotation.z = Math.cos(time * 30) * 0.45;

    if (neutronAura) {
      const pulseScale = 1.0 + Math.sin(time * 40) * 0.15;
      neutronAura.scale.set(pulseScale, pulseScale, pulseScale);
    }

    updateJetParticles();
  }

  updateSolarSystem(time);

  // Update the spiraling comment animation
  updateActiveComment(0.016);

  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function updatePreview() {
  const nameVal = document.getElementById('user-name').value.trim();
  const msgVal = document.getElementById('user-msg').value.trim();
  const mediaUrl = sanitizeMediaPreview(document.getElementById('media-url').value.trim());
  const mediaTypeSelect = document.getElementById('media-type');
  const selectedFile = getSelectedMediaFile();
  const fileMediaType = inferMediaTypeFromFile(selectedFile);
  const previewText = document.getElementById('text-preview');
  const previewBox = document.querySelector('.msg-bubble-preview');

  document.getElementById('name-preview').innerText = nameVal || 'Minh Anh';
  previewText.innerText = msgVal || 'Chuột Chat đỉnh cao ghê! 🚀';
  document.getElementById('avatar-preview').innerText = (nameVal || 'M').charAt(0).toUpperCase();

  if (selectedFile && fileMediaType) {
    if (mediaTypeSelect && !mediaTypeSelect.value) mediaTypeSelect.value = fileMediaType;
    revokeActivePreviewObjectUrl();
    activePreviewObjectUrl = URL.createObjectURL(selectedFile);
    previewText.innerHTML = `${previewText.innerText}<br>${fileMediaType === 'image' ? `<img src="${activePreviewObjectUrl}" alt="preview" style="max-width:100%;margin-top:8px;border-radius:10px;" />` : `<video controls src="${activePreviewObjectUrl}" style="max-width:100%;margin-top:8px;border-radius:10px;"></video>`}`;
  } else if (mediaUrl && mediaTypeSelect.value === 'image') {
    previewText.innerHTML = `${previewText.innerText}<br><img src="${mediaUrl}" alt="preview" style="max-width:100%;margin-top:8px;border-radius:10px;" />`;
  } else if (mediaUrl && mediaTypeSelect.value === 'video') {
    previewText.innerHTML = `${previewText.innerText}<br><video controls src="${mediaUrl}" style="max-width:100%;margin-top:8px;border-radius:10px;"></video>`;
  } else {
    previewText.innerHTML = previewText.innerText;
  }

  if (previewBox) {
    previewBox.style.minHeight = (mediaUrl || selectedFile) ? '220px' : 'auto';
  }
}

async function handleCommentSubmit(event) {
  event.preventDefault();
  const nameInput = document.getElementById('user-name');
  const msgInput = document.getElementById('user-msg');
  const mediaUrlInput = document.getElementById('media-url');
  const mediaTypeInput = document.getElementById('media-type');
  const mediaFileInput = document.getElementById('media-file');

  const name = nameInput.value.trim();
  const text = msgInput.value.trim();
  const mediaUrl = mediaUrlInput.value.trim();
  const selectedFile = getSelectedMediaFile();
  const fileMediaType = inferMediaTypeFromFile(selectedFile);
  const mediaType = (fileMediaType || mediaTypeInput.value || '').toLowerCase();

  if (name && text) {
    let savedComment = null;
    if (selectedFile && fileMediaType) {
      const formData = new FormData();
      formData.append('name', name);
      formData.append('text', text);
      formData.append('media_type', mediaType);
      formData.append('media_url', mediaUrl);
      formData.append('media_file', selectedFile);
      savedComment = await saveCommentToDatabase(formData, true);
    } else {
      const payload = {
        name,
        text,
        media_type: mediaType || '',
        media_url: mediaType === 'image' || mediaType === 'video' ? mediaUrl : ''
      };
      savedComment = await saveCommentToDatabase(payload);
    }

    const newComment = {
      name: savedComment?.name || name,
      text: savedComment?.text || text,
      media_type: savedComment?.media_type || mediaType,
      media_url: savedComment?.media_url || (mediaType === 'image' || mediaType === 'video' ? mediaUrl : ''),
      index: commentQueue.length
    };
    commentQueue.push(newComment);
    initialComments.push(newComment);
    nameInput.value = '';
    msgInput.value = '';
    mediaUrlInput.value = '';
    mediaTypeInput.value = '';
    if (mediaFileInput) mediaFileInput.value = '';
    revokeActivePreviewObjectUrl();
    updatePreview();
    updateCommentCountDisplay();

    showToast(savedComment
      ? `Bình luận của ${name} đã được lưu vào quỹ đạo Hố Đen!`
      : `Bình luận của ${name} đang hiển thị tạm thời.`);
  }
}

function showToast(message) {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toast-message');
  toastMsg.innerText = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 4000);
}

function setupFooterSecretTrigger() {
  const trigger = document.querySelector('.footer-secret-trigger');
  if (!trigger) return;

  const openHiddenPage = () => {
    window.location.href = 'skcode1234567890.html';
  };

  trigger.addEventListener('click', openHiddenPage);
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openHiddenPage();
    }
  });
}

setupFooterSecretTrigger();
window.addEventListener('DOMContentLoaded', initThree);
