// Initialize Lucide Icons
lucide.createIcons();

const initialComments = [];
let activePreviewObjectUrl = null;
const localCommentMediaUrls = new Set();

const COMMENT_EDITOR_STORAGE_KEY = 'directchat-comment-samples';
const COMMENT_MEDIA_CACHE_KEY = 'directchat-comment-media';
const LOCAL_MEDIA_DB_NAME = 'directchat-local-media';
const LOCAL_MEDIA_STORE_NAME = 'comments';
let localMediaDbPromise = null;

window.addEventListener('beforeunload', () => {
  localCommentMediaUrls.forEach((url) => URL.revokeObjectURL(url));
});

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
    if (!Array.isArray(comments)) return [];

    const normalizedComments = comments
      .map((comment) => ({
        name: String(comment?.name || '').trim().slice(0, 24),
        text: String(comment?.text || '').trim().slice(0, 120),
        created_at: String(comment?.created_at || comment?.createdAt || '').trim(),
        id: String(comment?.id || comment?._id || '').trim(),
        ...getCommentMedia(comment),
        storage_label: String(comment?.storage_label || (comment?.storage_id ? `Sanity #${comment.storage_id}` : '')).trim()
      }))
      .filter((comment) => comment.name && comment.text)
      .map(mergeCachedCommentMedia);

    const commentsWithMedia = await Promise.all(normalizedComments.map(loadLocalCommentMedia));
    return commentsWithMedia.sort((newer, older) => {
        const newerTime = Date.parse(newer.created_at);
        const olderTime = Date.parse(older.created_at);
        if (!Number.isFinite(newerTime) || !Number.isFinite(olderTime)) return 0;
        return olderTime - newerTime;
      });
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeMediaPreview(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.href;
  } catch {
    return '';
  }
}

function inferMediaTypeFromUrl(url) {
  const cleanUrl = String(url || '').split(/[?#]/, 1)[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(cleanUrl)) return 'image';
  if (/\.(mp4|webm|ogg|mov|m4v)$/i.test(cleanUrl)) return 'video';
  return '';
}

function extractMediaFromText(text) {
  const urls = String(text || '').match(/https?:\/\/[^\s<>'"`]+/g) || [];
  for (const rawUrl of urls) {
    const mediaUrl = sanitizeMediaPreview(rawUrl.replace(/[),.!?]+$/g, ''));
    const mediaType = inferMediaTypeFromUrl(mediaUrl);
    if (mediaType && mediaUrl) return { media_type: mediaType, media_url: mediaUrl };
  }
  return { media_type: '', media_url: '' };
}

function getCommentMedia(comment) {
  const mediaUrl = sanitizeMediaPreview(comment?.media_url || comment?.mediaUrl || '');
  const explicitType = String(comment?.media_type || comment?.mediaType || '').trim().toLowerCase();
  if (!mediaUrl) return extractMediaFromText(comment?.text);
  const mediaType = explicitType === 'image' || explicitType === 'video'
    ? explicitType
    : inferMediaTypeFromUrl(mediaUrl);
  return {
    media_type: mediaType,
    media_url: mediaType && mediaUrl ? mediaUrl : ''
  };
}

function getCommentMediaCacheKey(comment) {
  const id = String(comment?.id || comment?._id || '').trim();
  if (id) return `id:${id}`;
  const name = String(comment?.name || '').trim().toLowerCase();
  const text = String(comment?.text || '').trim().toLowerCase();
  return name && text ? `content:${name}|${text}` : '';
}

function readCommentMediaCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(COMMENT_MEDIA_CACHE_KEY) || '{}');
    return cache && typeof cache === 'object' ? cache : {};
  } catch {
    return {};
  }
}

function mergeCachedCommentMedia(comment) {
  if (comment.media_url) return comment;
  const cached = readCommentMediaCache()[getCommentMediaCacheKey(comment)];
  if (!cached) return comment;
  return { ...comment, ...getCommentMedia(cached) };
}

function rememberCommentMedia(comment) {
  const media = getCommentMedia(comment);
  const key = getCommentMediaCacheKey(comment);
  if (!key || !media.media_url || media.media_url.startsWith('blob:')) return;
  const cache = readCommentMediaCache();
  cache[key] = media;
  try {
    localStorage.setItem(COMMENT_MEDIA_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Media cache is an enhancement; the comment itself remains usable.
  }
}

function openLocalMediaDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (localMediaDbPromise) return localMediaDbPromise;
  localMediaDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_MEDIA_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LOCAL_MEDIA_STORE_NAME)) {
        request.result.createObjectStore(LOCAL_MEDIA_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(() => null);
  return localMediaDbPromise;
}

async function saveLocalCommentMedia(comment, file) {
  const key = getCommentMediaCacheKey(comment);
  if (!key || !file) return;
  const db = await openLocalMediaDb();
  if (!db) return;
  await new Promise((resolve) => {
    const transaction = db.transaction(LOCAL_MEDIA_STORE_NAME, 'readwrite');
    transaction.objectStore(LOCAL_MEDIA_STORE_NAME).put(file, key);
    transaction.oncomplete = resolve;
    transaction.onerror = resolve;
    transaction.onabort = resolve;
  });
}

async function loadLocalCommentMedia(comment) {
  if (comment.media_url) return comment;
  const key = getCommentMediaCacheKey(comment);
  if (!key) return comment;
  const db = await openLocalMediaDb();
  if (!db) return comment;
  const file = await new Promise((resolve) => {
    const request = db.transaction(LOCAL_MEDIA_STORE_NAME, 'readonly')
      .objectStore(LOCAL_MEDIA_STORE_NAME)
      .get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
  if (!file) return comment;
  const mediaUrl = URL.createObjectURL(file);
  localCommentMediaUrls.add(mediaUrl);
  return {
    ...comment,
    media_type: inferMediaTypeFromFile(file),
    media_url: mediaUrl
  };
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
const FOCUS_BENCHMARK  = 'benchmark-fractal';

// The benchmark is intentionally well outside the solar-system cluster so the
// camera has to travel to a separate, GPU-heavy scene.
const BENCHMARK_SPHERE_POSITION = new THREE.Vector3(260, 120, -270);
let benchmarkSphereGroup = null;
const benchmarkShaderMaterials = [];
let benchmarkJaggedSpikes = null;
const BENCHMARK_SPIKE_COUNT = 100000;
const BENCHMARK_PROCEDURAL_SPIKE_COUNT = 2_000_000_000_000_000_000;

let benchmarkFpsPanel = null;
let benchmarkFpsValue = null;
let benchmarkFpsDetail = null;
let benchmarkFpsLastTimestamp = 0;
let benchmarkFpsFrameCount = 0;
let benchmarkTargetRotationX = 0;
let benchmarkTargetRotationY = 0;
let benchmarkTargetRotationZ = 0;
let benchmarkCameraRotationX = 0;
let benchmarkCameraRotationY = 0;

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

// GPU benchmark object: a high-subdivision icosphere whose surface is
// displaced by animated multi-octave 3D fractal noise. The shader keeps the
// geometry procedural while the dense mesh and surface points provide a real
// render workload for requestAnimationFrame/WebGL.
function createFractalBenchmarkSphere() {
  benchmarkSphereGroup = new THREE.Group();
  benchmarkSphereGroup.position.copy(BENCHMARK_SPHERE_POSITION);
  benchmarkSphereGroup.userData.benchmarkTarget = true;
  benchmarkSphereGroup.userData.proceduralProtrusionCount = BENCHMARK_PROCEDURAL_SPIKE_COUNT;
  benchmarkSphereGroup.userData.colorModel = 'asynchronous-argb-gradient';
  scene.add(benchmarkSphereGroup);

  const vertexShader = `
    uniform float uTime;
    uniform float uRadius;
    uniform float uMicroDensity;
    varying vec3 vNormal;
    varying vec3 vDirection;
    varying float vFractal;
    varying float vRidge;

    float hash(vec3 p) {
      p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    float noise3d(vec3 p) {
      vec3 cell = floor(p);
      vec3 local = fract(p);
      local = local * local * (3.0 - 2.0 * local);

      float x00 = mix(hash(cell), hash(cell + vec3(1.0, 0.0, 0.0)), local.x);
      float x10 = mix(hash(cell + vec3(0.0, 1.0, 0.0)), hash(cell + vec3(1.0, 1.0, 0.0)), local.x);
      float x01 = mix(hash(cell + vec3(0.0, 0.0, 1.0)), hash(cell + vec3(1.0, 0.0, 1.0)), local.x);
      float x11 = mix(hash(cell + vec3(0.0, 1.0, 1.0)), hash(cell + vec3(1.0, 1.0, 1.0)), local.x);
      return mix(mix(x00, x10, local.y), mix(x01, x11, local.y), local.z);
    }

    float fbm(vec3 p) {
      float value = 0.0;
      float amplitude = 0.5;
      for (int octave = 0; octave < 6; octave++) {
        value += amplitude * noise3d(p);
        p = p * 2.03 + vec3(13.1, 7.7, 5.3);
        amplitude *= 0.5;
      }
      return value;
    }

    float ridgedFbm(vec3 p) {
      float value = 0.0;
      float amplitude = 0.5;
      for (int octave = 0; octave < 6; octave++) {
        float ridge = 1.0 - abs(noise3d(p) * 2.0 - 1.0);
        value += ridge * ridge * amplitude;
        p = p * 2.08 + vec3(9.2, 4.6, 15.7);
        amplitude *= 0.5;
      }
      return value;
    }

    // Repeats the same 3D cell at a smaller scale on every pass. Sixteen
    // passes plus the orbit fold approximate the requested self-similar
    // infinity: each pass contributes smaller protrusions and cavities.
    float recursiveScaleField(vec3 p) {
      float value = 0.0;
      float amplitude = 1.0;
      float scale = 1.0;
      vec3 folded = p;
      for (int level = 0; level < 16; level++) {
        folded = abs(folded);
        if (folded.x < folded.y) folded.xy = folded.yx;
        if (folded.x < folded.z) folded.xz = folded.zx;
        if (folded.y < folded.z) folded.yz = folded.zy;
        folded = folded * 1.73 - vec3(0.52, 0.37, 0.29);
        vec3 cell = abs(fract(folded * scale) - 0.5);
        float cubeLobe = 1.0 - smoothstep(0.08, 0.46, max(cell.x, max(cell.y, cell.z)));
        float creaseLobe = 1.0 - smoothstep(0.02, 0.23, min(cell.x, min(cell.y, cell.z)));
        value += (cubeLobe * 0.64 + creaseLobe * 0.36) * amplitude;
        scale *= 2.03;
        amplitude *= 0.5;
      }
      return value / 1.98;
    }

    float recursiveOrbitField(vec3 p) {
      vec3 z = p;
      float closestShell = 1000.0;
      for (int level = 0; level < 14; level++) {
        z = abs(z);
        if (z.x < z.y) z.xy = z.yx;
        if (z.x < z.z) z.xz = z.zx;
        if (z.y < z.z) z.yz = z.zy;
        z = z * 1.86 - vec3(0.65, 0.49, 0.58);
        z += p * 0.07;
        closestShell = min(closestShell, abs(length(z) - 0.68));
      }
      return 1.0 - smoothstep(0.015, 0.34, closestShell);
    }

    // Procedural micro-lobes represent two quintillion (2 x 10^18) tiny
    // protrusions without allocating two quintillion instance matrices. The density drives the base
    // scale, while successive layers keep shrinking toward pixel precision.
    float proceduralMicroSpikes(vec3 p) {
      float value = 0.0;
      float amplitude = 0.42;
      float scale = max(32.0, pow(uMicroDensity, 0.3333333));
      for (int level = 0; level < 8; level++) {
        vec3 cell = abs(fract(p * scale) - 0.5);
        float needle = 1.0 - smoothstep(0.012, 0.22, length(cell));
        float ridge = 1.0 - smoothstep(0.025, 0.38, max(cell.x, max(cell.y, cell.z)));
        value += mix(needle, ridge, 0.35) * amplitude;
        scale *= 1.92;
        amplitude *= 0.5;
      }
      return clamp(value, 0.0, 1.0);
    }

    void main() {
      vec3 direction = normalize(position);
      float macro = fbm(direction * 2.25 + vec3(uTime * 0.012, 0.0, 0.0));
      float ridged = ridgedFbm(direction * 5.5 - vec3(0.0, uTime * 0.018, 0.0));
      float sharpRidges = ridgedFbm(direction * 13.0 + vec3(uTime * 0.021, 0.0, 0.0));
      float micro = fbm(direction * 31.0 + vec3(0.0, 0.0, uTime * 0.03));
      float recursive = recursiveScaleField(direction * 1.45 + vec3(0.13, 0.37, 0.71) + vec3(uTime * 0.001));
      float recursiveFine = recursiveScaleField(direction * 2.9 - vec3(0.47, 0.19, 0.31) - vec3(uTime * 0.0014));
      float orbitFractal = recursiveOrbitField(direction * 1.18 + vec3(0.23, 0.41, 0.17));
      float orbitFine = recursiveOrbitField(direction * 2.36 - vec3(0.31, 0.16, 0.44));
      float microSpikes = proceduralMicroSpikes(direction * 0.74 + vec3(0.17, 0.29, 0.43));
      float spikeField = pow(clamp(sharpRidges, 0.0, 1.0), 2.2);
      float recursivePeaks = pow(clamp(recursive, 0.0, 1.0), 1.35);
      float displacement = (macro - 0.46) * 15.0
        + (ridged - 0.45) * 18.0
        + (spikeField - 0.18) * 22.0
        + (recursivePeaks - 0.26) * 24.0
        + (recursiveFine - 0.34) * 10.0
        + (orbitFractal - 0.35) * 18.0
        + (orbitFine - 0.28) * 8.0
        + (microSpikes - 0.24) * 3.2
        + (micro - 0.5) * 5.0;
      displacement = clamp(displacement, -20.0, 30.0);

      vec3 displaced = direction * (uRadius + displacement);
      vDirection = direction;
      vFractal = clamp(macro * 0.24 + ridged * 0.11 + spikeField * 0.11 + recursive * 0.21 + recursiveFine * 0.08 + orbitFractal * 0.14 + orbitFine * 0.04 + microSpikes * 0.05 + micro * 0.02, 0.0, 1.0);
      vRidge = clamp(ridged * 0.15 + spikeField * 0.23 + recursivePeaks * 0.36 + orbitFractal * 0.2 + microSpikes * 0.06, 0.0, 1.0);
      vNormal = normalize(normalMatrix * direction);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
    }
  `;

  const fragmentShader = `
    uniform float uTime;
    uniform float uGradientOffset;
    uniform float uMicroDensity;
    varying vec3 vNormal;
    varying vec3 vDirection;
    varying float vFractal;
    varying float vRidge;

    vec3 hsv2rgb(vec3 c) {
      vec4 k = vec4(1.0, 0.6666667, 0.3333333, 3.0);
      vec3 p = abs(fract(c.xxx + k.xyz) * 6.0 - k.www);
      return c.z * mix(k.xxx, clamp(p - k.xxx, 0.0, 1.0), c.y);
    }

    float recursiveScaleField(vec3 p) {
      float value = 0.0;
      float amplitude = 1.0;
      float scale = 1.0;
      vec3 folded = p;
      for (int level = 0; level < 16; level++) {
        folded = abs(folded);
        if (folded.x < folded.y) folded.xy = folded.yx;
        if (folded.x < folded.z) folded.xz = folded.zx;
        if (folded.y < folded.z) folded.yz = folded.zy;
        folded = folded * 1.73 - vec3(0.52, 0.37, 0.29);
        vec3 cell = abs(fract(folded * scale) - 0.5);
        float cubeLobe = 1.0 - smoothstep(0.08, 0.46, max(cell.x, max(cell.y, cell.z)));
        float creaseLobe = 1.0 - smoothstep(0.02, 0.23, min(cell.x, min(cell.y, cell.z)));
        value += (cubeLobe * 0.64 + creaseLobe * 0.36) * amplitude;
        scale *= 2.03;
        amplitude *= 0.5;
      }
      return value / 1.98;
    }

    float recursiveOrbitField(vec3 p) {
      vec3 z = p;
      float closestShell = 1000.0;
      for (int level = 0; level < 14; level++) {
        z = abs(z);
        if (z.x < z.y) z.xy = z.yx;
        if (z.x < z.z) z.xz = z.zx;
        if (z.y < z.z) z.yz = z.zy;
        z = z * 1.86 - vec3(0.65, 0.49, 0.58);
        z += p * 0.07;
        closestShell = min(closestShell, abs(length(z) - 0.68));
      }
      return 1.0 - smoothstep(0.015, 0.34, closestShell);
    }

    float proceduralMicroSpikes(vec3 p) {
      float value = 0.0;
      float amplitude = 0.42;
      float scale = max(32.0, pow(uMicroDensity, 0.3333333));
      for (int level = 0; level < 8; level++) {
        vec3 cell = abs(fract(p * scale) - 0.5);
        float needle = 1.0 - smoothstep(0.012, 0.22, length(cell));
        float ridge = 1.0 - smoothstep(0.025, 0.38, max(cell.x, max(cell.y, cell.z)));
        value += mix(needle, ridge, 0.35) * amplitude;
        scale *= 1.92;
        amplitude *= 0.5;
      }
      return clamp(value, 0.0, 1.0);
    }

    void main() {
      vec3 normal = normalize(vNormal);
      vec3 lightDirection = normalize(vec3(-0.38, 0.72, 0.94));
      float lighting = 0.32 + 0.86 * max(dot(normal, lightDirection), 0.0);
      float relief = mix(0.62, 1.5, vRidge);
      vec3 direction = normalize(vDirection);
      float recursivePixels = recursiveScaleField(direction * 1.45 + vec3(0.13, 0.37, 0.71) + vec3(uTime * 0.001));
      float recursiveFinePixels = recursiveScaleField(direction * 2.9 - vec3(0.47, 0.19, 0.31) - vec3(uTime * 0.0014));
      float orbitPixels = recursiveOrbitField(direction * 1.18 + vec3(0.23, 0.41, 0.17));
      float orbitFinePixels = recursiveOrbitField(direction * 2.36 - vec3(0.31, 0.16, 0.44));
      float microSpikes = proceduralMicroSpikes(direction * 0.74 + vec3(0.17, 0.29, 0.43));
      float recursiveGlow = clamp(recursivePixels * 0.43 + recursiveFinePixels * 0.2 + orbitPixels * 0.2 + orbitFinePixels * 0.07 + microSpikes * 0.1, 0.0, 1.0);
      // Every material and every surface direction gets its own phase. This
      // keeps the ARGB gradient asynchronous instead of making the whole
      // sphere flash in lockstep.
      float gradientPhase = uTime * 0.16 + uGradientOffset * 1.73
        + vFractal * 1.85 + recursiveGlow * 1.65 + microSpikes * 2.4
        + vDirection.x * (0.34 + uGradientOffset * 0.11)
        + vDirection.y * (0.27 + uGradientOffset * 0.07)
        + vDirection.z * (0.42 + uGradientOffset * 0.13);
      float hue = fract(gradientPhase);
      vec3 gradientA = hsv2rgb(vec3(hue, 0.9, 1.0));
      vec3 gradientB = hsv2rgb(vec3(fract(hue + 0.2), 0.82, 1.0));
      vec3 color = mix(gradientA, gradientB, smoothstep(0.12, 0.92, max(vRidge, recursiveGlow)));

      // Keep the requested channel order explicit as ARGB internally, then
      // convert to WebGL's RGBA output order at the final line.
      vec4 argbGradient = vec4(
        0.5 + 0.5 * sin(gradientPhase * 0.73 + uTime * 0.41 + 1.1),
        0.5 + 0.5 * sin(gradientPhase * 1.17 + uTime * 0.29 + 0.6),
        0.5 + 0.5 * sin(gradientPhase * 0.91 + uTime * 0.37 + 2.2),
        0.5 + 0.5 * sin(gradientPhase * 1.33 + uTime * 0.23 + 4.4)
      );
      color = mix(color, argbGradient.yzw, 0.24);
      color *= lighting * relief;
      color += vec3(1.0) * pow(vRidge, 5.0) * 0.18;

      // WebGL stores the fragment as RGBA; this animated alpha channel keeps
      // the requested ARGB-style gradient alive without making the sphere vanish.
      float alpha = 0.76 + 0.24 * argbGradient.x;
      gl_FragColor = vec4(color, alpha);
    }
  `;

  const mainMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: 36 },
      uGradientOffset: { value: 0.17 },
      uMicroDensity: { value: BENCHMARK_PROCEDURAL_SPIKE_COUNT }
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    side: THREE.FrontSide
  });
  benchmarkShaderMaterials.push(mainMaterial);

  const mainMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(36, 6), mainMaterial);
  mainMesh.name = 'Fractal benchmark surface';
  benchmarkSphereGroup.add(mainMesh);

  const shellMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: 41 },
      uGradientOffset: { value: 3.41 },
      uMicroDensity: { value: BENCHMARK_PROCEDURAL_SPIKE_COUNT }
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    opacity: 0.36,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    wireframe: true,
    side: THREE.DoubleSide
  });
  benchmarkShaderMaterials.push(shellMaterial);
  benchmarkSphereGroup.add(new THREE.Mesh(new THREE.IcosahedronGeometry(41, 5), shellMaterial));

  const surfacePointCount = 18000;
  const surfacePositions = new Float32Array(surfacePointCount * 3);
  const surfaceColors = new Float32Array(surfacePointCount * 3);
  let seed = 918273;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let i = 0; i < surfacePointCount; i += 1) {
    const z = random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const radial = Math.sqrt(Math.max(0, 1 - z * z));
    const radius = 39.2 + random() * 3.8;
    const offset = i * 3;
    surfacePositions[offset] = Math.cos(angle) * radial * radius;
    surfacePositions[offset + 1] = z * radius;
    surfacePositions[offset + 2] = Math.sin(angle) * radial * radius;

    const color = new THREE.Color().setHSL((0.48 + random() * 0.48) % 1, 0.88, 0.58);
    surfaceColors[offset] = color.r;
    surfaceColors[offset + 1] = color.g;
    surfaceColors[offset + 2] = color.b;
  }

  const surfaceGeometry = new THREE.BufferGeometry();
  surfaceGeometry.setAttribute('position', new THREE.BufferAttribute(surfacePositions, 3));
  surfaceGeometry.setAttribute('color', new THREE.BufferAttribute(surfaceColors, 3));
  const surfacePoints = new THREE.Points(surfaceGeometry, new THREE.PointsMaterial({
    size: 0.34,
    vertexColors: true,
    transparent: true,
    opacity: 0.78,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true
  }));
  surfacePoints.name = 'Fractal benchmark color detail';
  benchmarkSphereGroup.add(surfacePoints);

  // A visible 100,000-instance low-poly layer makes the silhouette readable;
  // the shader above supplies the two-quintillion procedural micro-lobes.
  const spikeGeometry = new THREE.ConeGeometry(0.32, 1, 4, 1);
  const spikeMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.94,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  benchmarkJaggedSpikes = new THREE.InstancedMesh(spikeGeometry, spikeMaterial, BENCHMARK_SPIKE_COUNT);
  benchmarkJaggedSpikes.name = '100,000 visible spikes + 2e18 procedural protrusions';
  benchmarkJaggedSpikes.userData.spikeCount = BENCHMARK_SPIKE_COUNT;
  benchmarkJaggedSpikes.userData.proceduralSpikeCount = BENCHMARK_PROCEDURAL_SPIKE_COUNT;

  const spikeDummy = new THREE.Object3D();
  const spikeUp = new THREE.Vector3(0, 1, 0);
  const spikeDirection = new THREE.Vector3();
  const spikeColor = new THREE.Color();
  let spikeSeed = 472991;
  const spikeRandom = () => {
    spikeSeed = (spikeSeed * 1664525 + 1013904223) >>> 0;
    return spikeSeed / 4294967296;
  };

  for (let i = 0; i < BENCHMARK_SPIKE_COUNT; i += 1) {
    const z = spikeRandom() * 2 - 1;
    const angle = spikeRandom() * Math.PI * 2;
    const radial = Math.sqrt(Math.max(0, 1 - z * z));
    spikeDirection.set(Math.cos(angle) * radial, z, Math.sin(angle) * radial).normalize();

    const spikeLength = 0.42 + spikeRandom() * 2.4;
    const spikeWidth = 0.16 + spikeRandom() * 0.28;
    const surfaceRadius = 41.2 + (spikeRandom() - 0.5) * 2.2;
    spikeDummy.position.copy(spikeDirection).multiplyScalar(surfaceRadius + spikeLength * 0.5);
    spikeDummy.quaternion.setFromUnitVectors(spikeUp, spikeDirection);
    spikeDummy.scale.set(spikeWidth, spikeLength, spikeWidth);
    spikeDummy.updateMatrix();
    benchmarkJaggedSpikes.setMatrixAt(i, spikeDummy.matrix);

    spikeColor.setHSL(
      (i / BENCHMARK_SPIKE_COUNT + spikeRandom() * 0.17) % 1,
      0.94,
      0.58
    );
    benchmarkJaggedSpikes.setColorAt(i, spikeColor);
  }

  benchmarkJaggedSpikes.instanceMatrix.needsUpdate = true;
  if (benchmarkJaggedSpikes.instanceColor) benchmarkJaggedSpikes.instanceColor.needsUpdate = true;
  benchmarkSphereGroup.add(benchmarkJaggedSpikes);

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(45, 32, 20),
    new THREE.MeshBasicMaterial({
      color: 0x7c3aed,
      transparent: true,
      opacity: 0.055,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  );
  benchmarkSphereGroup.add(halo);

  [0.31, -0.48].forEach((tilt, index) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(44 + index * 1.4, 0.11, 8, 160),
      new THREE.MeshBasicMaterial({
        color: index === 0 ? 0x22d3ee : 0xf472b6,
        transparent: true,
        opacity: 0.26,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    ring.rotation.x = Math.PI / 2 + tilt;
    ring.rotation.z = tilt * 0.7;
    benchmarkSphereGroup.add(ring);
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
  createFractalBenchmarkSphere();
  buildCommentQueue();
  const commentStartTimer = setTimeout(() => {
    if (!activeCommentNodes.length) startNextCommentBatch();
  }, 1000);

  // Do not hold WebGL setup, controls, or the first render hostage to a
  // serverless/API request. Comments are merged when the request completes.
  loadRemoteComments().then((remoteComments) => {
    if (!remoteComments.length) return;
    // The API returns newest-first. Keep that order and place remote comments
    // before local fallback comments in the black-hole display queue.
    initialComments.unshift(...remoteComments.slice(0, 12));
    buildCommentQueue();
    clearTimeout(commentStartTimer);
    showNewestCommentBatch();
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
  const nextCommentBatchButton = document.getElementById('next-comment-batch');
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
    } else if (target === FOCUS_BENCHMARK) {
      focusOnBenchmarkSphere();
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

  if (nextCommentBatchButton) {
    nextCommentBatchButton.addEventListener('click', startNextCommentBatch);
  }
}

function resolveBenchmarkFpsHud() {
  if (benchmarkFpsPanel) return true;
  benchmarkFpsPanel = document.getElementById('benchmark-fps');
  benchmarkFpsValue = document.getElementById('benchmark-fps-value');
  benchmarkFpsDetail = document.getElementById('benchmark-fps-detail');
  return Boolean(benchmarkFpsPanel && benchmarkFpsValue && benchmarkFpsDetail);
}

function showBenchmarkFps() {
  if (!resolveBenchmarkFpsHud()) return;
  benchmarkFpsPanel.hidden = false;
  benchmarkFpsValue.textContent = '-- FPS';
  benchmarkFpsDetail.textContent = 'Đang đo từ requestAnimationFrame...';
  benchmarkFpsLastTimestamp = performance.now();
  benchmarkFpsFrameCount = 0;
}

function hideBenchmarkFps() {
  if (!resolveBenchmarkFpsHud()) return;
  benchmarkFpsPanel.hidden = true;
  benchmarkFpsLastTimestamp = 0;
  benchmarkFpsFrameCount = 0;
}

function updateBenchmarkFps(timestamp) {
  if (cameraFocusTarget !== FOCUS_BENCHMARK || !resolveBenchmarkFpsHud() || benchmarkFpsPanel.hidden) return;
  if (!benchmarkFpsLastTimestamp) benchmarkFpsLastTimestamp = timestamp;

  benchmarkFpsFrameCount += 1;
  const elapsed = timestamp - benchmarkFpsLastTimestamp;
  if (elapsed < 750) return;

  const fps = benchmarkFpsFrameCount * 1000 / elapsed;
  const frameTime = 1000 / Math.max(fps, 0.1);
  benchmarkFpsValue.textContent = `${Math.round(fps)} FPS`;
  benchmarkFpsDetail.textContent = `${frameTime.toFixed(1)} ms/frame • WebGL thực tế`;
  benchmarkFpsLastTimestamp = timestamp;
  benchmarkFpsFrameCount = 0;
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
  const orbitInstruction = cameraFocusTarget === FOCUS_BENCHMARK
    ? 'Kéo chuột xoay mọi góc • Shift + kéo ngang để roll — Click vùng trống để thoát'
    : 'Click vào vùng trống để thoát';
  hint.innerText = `📷 Đang quan sát: ${objectName} — ${orbitInstruction}`;
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

  if (benchmarkSphereGroup && raycaster.intersectObjects(benchmarkSphereGroup.children, true).length > 0) {
    focusOnBenchmarkSphere();
    return;
  }

  if (cameraFocusTarget !== FOCUS_FREE) {
    returnToFreeOrbit();
  }
}

function focusOnBlackHole() {
  cameraFocusTarget = FOCUS_BLACK_HOLE;
  hideBenchmarkFps();
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

function focusOnBenchmarkSphere() {
  const wasAlreadyBenchmark = cameraFocusTarget === FOCUS_BENCHMARK;
  cameraFocusTarget = FOCUS_BENCHMARK;
  focusedPlanetEntry = null;
  focusedGalaxyEntry = null;
  cameraTransitioning = true;
  stopCelestialAudio();

  const spherePosition = benchmarkSphereGroup
    ? benchmarkSphereGroup.position
    : BENCHMARK_SPHERE_POSITION;
  const dist = 108;
  const relative = camera.position.clone().sub(spherePosition);
  const relativeLength = relative.length();
  const direction = relativeLength > 0.001
    ? relative.multiplyScalar(1 / relativeLength)
    : new THREE.Vector3(0.35, 0.2, 0.92).normalize();

  cameraPositionTarget.copy(spherePosition).addScaledVector(direction, dist);
  cameraLookTarget.copy(spherePosition);
  benchmarkCameraRotationY = Math.atan2(direction.x, direction.z);
  benchmarkCameraRotationX = Math.asin(Math.max(-1, Math.min(1, direction.y)));
  if (!wasAlreadyBenchmark && benchmarkSphereGroup) {
    benchmarkTargetRotationX = benchmarkSphereGroup.rotation.x;
    benchmarkTargetRotationY = benchmarkSphereGroup.rotation.y;
    benchmarkTargetRotationZ = benchmarkSphereGroup.rotation.z;
  }
  currentRotationY = Math.atan2(direction.x, direction.z);
  currentRotationX = Math.asin(Math.max(-1, Math.min(1, direction.y)));
  targetRotationY = currentRotationY;
  targetRotationX = currentRotationX;
  cameraDistance = dist;

  showBenchmarkFps();
  showFocusHint('Fractal GPU Benchmark');
}

function focusOnNeutronStar() {
  cameraFocusTarget = FOCUS_NEUTRON;
  hideBenchmarkFps();
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
  hideBenchmarkFps();
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
  hideBenchmarkFps();
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
  hideBenchmarkFps();
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

function applyOrbitDrag(deltaX, deltaY, roll = false) {
  if (cameraFocusTarget === FOCUS_BENCHMARK) {
    // The benchmark camera is fixed; dragging rotates only the sphere.
    // Benchmark axis mapping is intentionally swapped: horizontal drag -> X,
    // vertical drag -> Y.
    if (roll) {
      benchmarkTargetRotationZ -= deltaX * 0.006;
    } else {
      benchmarkTargetRotationX -= deltaX * 0.006;
      benchmarkTargetRotationY += deltaY * 0.006;
    }
    return;
  }

  targetRotationY -= deltaX * 0.006;
  targetRotationX += deltaY * 0.006;
  targetRotationX = Math.max(-Math.PI / 2.05, Math.min(Math.PI / 2.05, targetRotationX));
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

    applyOrbitDrag(deltaX, deltaY, e.shiftKey);

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

    applyOrbitDrag(deltaX, deltaY);

    previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  });

  window.addEventListener('touchend', () => { isMouseDown = false; });
}

// ─── Comment Queue System ────────────────────────────────────────────────────
// Shows one comment at a time: appears at outer orbit, spirals into black hole, disappears
let commentQueue = [];
let activeCommentBatchNumber = -1;
let activeCommentNodes = [];
let commentLifeTimer = 0;
const COMMENT_BATCH_SIZE = 5;
const COMMENT_DURATION = 20; // seconds per batch — switch to the next group every 20s
const BH_RADIUS = 11; // event horizon visual radius (~7.8 * 1.45)
const ORBIT_START_RADIUS_A = BH_RADIUS + 22;
const ORBIT_START_RADIUS_B = BH_RADIUS + 14;

function buildCommentQueue() {
  commentQueue = initialComments.map((c, i) => ({ ...c, index: i }));
}

function removeActiveCommentSprites() {
  activeCommentNodes.forEach((node) => {
    if (!node?.sprite) return;
    scene.remove(node.sprite);
    node.disposed = true;
    node.videos?.forEach((video) => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    });
    node.materials?.forEach((material) => {
      if (material.map) material.map.dispose();
      material.dispose();
    });
  });
  activeCommentNodes = [];
}

function addCommentMediaPreview(node, mediaType, mediaUrl) {
  if (!mediaType || !mediaUrl) return;

  const addTextureSprite = (texture, aspectRatio) => {
    if (node.disposed) {
      texture.dispose();
      return;
    }

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 1
    });
    const mediaSprite = new THREE.Sprite(material);
    const maxWidth = 10;
    const maxHeight = 3.8;
    const height = Math.min(maxHeight, maxWidth / Math.max(aspectRatio, 0.25));
    mediaSprite.scale.set(height * Math.max(aspectRatio, 0.25), height, 1);
    mediaSprite.position.set(0, -2.7, 0.15);
    node.sprite.add(mediaSprite);
    node.materials.push(material);
  };

  if (mediaType === 'image') {
    const image = new Image();
    if (!mediaUrl.startsWith('blob:') && !mediaUrl.startsWith('data:')) image.crossOrigin = 'anonymous';
    image.onload = () => {
      const texture = new THREE.Texture(image);
      texture.needsUpdate = true;
      addTextureSprite(texture, image.naturalWidth / image.naturalHeight || 1);
    };
    image.src = mediaUrl;
    return;
  }

  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = mediaUrl;
  node.videos.push(video);
  video.addEventListener('loadedmetadata', () => {
    const texture = new THREE.VideoTexture(video);
    texture.minFilter = THREE.LinearFilter;
    addTextureSprite(texture, video.videoWidth / video.videoHeight || 16 / 9);
    video.play().catch(() => {});
  }, { once: true });
  video.load();
}

function createCommentSprite(entry, slot, visibleCount) {
  // Floating bubbles should show only the comment itself; storage metadata
  // remains available in the editor/media views.
  const canvas = createMessengerBubbleCanvas(entry.name, entry.text);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({ 
    map: texture, 
    transparent: true,
    opacity: 1.0
  });

  const sprite = new THREE.Group();
  const textSprite = new THREE.Sprite(material);
  const canvasAspect = canvas.width / canvas.height;
  const bubbleScale = visibleCount > 1 ? 2.75 : 3.2 * 1.35;
  textSprite.scale.set(canvasAspect * bubbleScale, bubbleScale, 1);
  const media = getCommentMedia(entry);
  textSprite.position.y = media.media_url ? 1.8 : 0;
  sprite.add(textSprite);

  const startAngle = (slot / visibleCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
  sprite.position.set(
    Math.cos(startAngle) * ORBIT_START_RADIUS_A,
    Math.sin(startAngle) * 3,
    Math.sin(startAngle) * ORBIT_START_RADIUS_B
  );

  scene.add(sprite);

  const node = {
    sprite,
    angle: startAngle,
    baseScaleX: 1,
    baseScaleY: 1,
    startRadiusA: ORBIT_START_RADIUS_A,
    startRadiusB: ORBIT_START_RADIUS_B,
    orbitTilt: (Math.random() - 0.5) * 0.6,
    materials: [material],
    videos: [],
    disposed: false
  };
  activeCommentNodes.push(node);
  addCommentMediaPreview(node, media.media_type, media.media_url);
}

function updateCommentBatchStatus() {
  const statusElem = document.getElementById('comment-batch-status');
  if (!statusElem) return;
  if (!commentQueue.length || activeCommentBatchNumber < 0) {
    statusElem.textContent = 'Chưa có bình luận';
    return;
  }
  const totalBatches = Math.ceil(commentQueue.length / COMMENT_BATCH_SIZE);
  statusElem.textContent = `Nhóm ${activeCommentBatchNumber + 1}/${totalBatches}`;
}

function startNextCommentBatch() {
  if (commentQueue.length === 0) {
    updateCommentBatchStatus();
    return;
  }

  removeActiveCommentSprites();

  const totalBatches = Math.max(1, Math.ceil(commentQueue.length / COMMENT_BATCH_SIZE));
  activeCommentBatchNumber = (activeCommentBatchNumber + 1) % totalBatches;
  const batchStart = activeCommentBatchNumber * COMMENT_BATCH_SIZE;
  const visibleCount = Math.min(COMMENT_BATCH_SIZE, commentQueue.length);

  for (let slot = 0; slot < visibleCount; slot += 1) {
    const entry = commentQueue[(batchStart + slot) % commentQueue.length];
    createCommentSprite(entry, slot, visibleCount);
  }

  commentLifeTimer = 0;
  updateCommentCountDisplay();
  updateCommentBatchStatus();
}

function showNewestCommentBatch() {
  activeCommentBatchNumber = -1;
  startNextCommentBatch();
}

function updateCommentCountDisplay() {
  const countElem = document.getElementById('comment-count');
  if (countElem) {
    const total = initialComments.length;
    countElem.innerText = `✨ ${total} lời nhắn đang bay vào Hố Đen`;
  }
}

function updateActiveComment(deltaTime) {
  if (!activeCommentNodes.length) return;

  commentLifeTimer += deltaTime;
  const progress = Math.min(commentLifeTimer / COMMENT_DURATION, 1); // 0→1 over 20s

  // First 25 seconds (progress 0→0.833): orbit normally at full radius
  // Last 5 seconds (progress 0.833→1): spiral into the black hole
  const SPIRAL_START = Math.max(0, (COMMENT_DURATION - 5) / COMMENT_DURATION);
  const FADE_START = Math.max(0, (COMMENT_DURATION - 2) / COMMENT_DURATION);
  const spiralProgress = progress > SPIRAL_START
    ? (progress - SPIRAL_START) / (1 - SPIRAL_START)
    : 0;

  activeCommentNodes.forEach((node) => {
    const currentRadiusA = node.startRadiusA * (1 - spiralProgress);
    const currentRadiusB = node.startRadiusB * (1 - spiralProgress);
    const angle = node.angle + progress * Math.PI * 1.8 + spiralProgress * Math.PI * 3;

    node.sprite.position.x = Math.cos(angle) * currentRadiusA;
    node.sprite.position.y = Math.sin(angle * 2) * (2 + node.orbitTilt * 4) * (1 - progress * 0.5);
    node.sprite.position.z = Math.sin(angle) * currentRadiusB;

    const scaleFactor = progress > SPIRAL_START ? 1 - spiralProgress * 0.7 : 1;
    node.sprite.scale.set(node.baseScaleX * scaleFactor, node.baseScaleY * scaleFactor, 1);

    if (progress > FADE_START) {
      const fadeOut = 1 - (progress - FADE_START) / (1 - FADE_START);
      node.materials.forEach((material) => {
        material.opacity = Math.max(0, fadeOut);
      });
    } else {
      node.materials.forEach((material) => {
        material.opacity = 1;
      });
    }
  });

  if (progress >= 1) {
    startNextCommentBatch();
  }
}

// 5. Render Loop
function animate(timestamp) {
  requestAnimationFrame(animate);

  const frameTimestamp = typeof timestamp === 'number' ? timestamp : performance.now();
  updateBenchmarkFps(frameTimestamp);
  const time = frameTimestamp * 0.001;

  currentRotationX += (targetRotationX - currentRotationX) * 0.06;
  currentRotationY += (targetRotationY - currentRotationY) * 0.06;

  let orbitCenter = new THREE.Vector3(0, 0, 0);
  if (cameraFocusTarget === FOCUS_NEUTRON && neutronGroup) {
    orbitCenter.copy(neutronGroup.position);
  } else if (cameraFocusTarget === FOCUS_PLANET && focusedPlanetEntry) {
    focusedPlanetEntry.mesh.getWorldPosition(orbitCenter);
  } else if (cameraFocusTarget === FOCUS_GALAXY && focusedGalaxyEntry) {
    orbitCenter.copy(focusedGalaxyEntry.group.position);
  } else if (cameraFocusTarget === FOCUS_BENCHMARK && benchmarkSphereGroup) {
    orbitCenter.copy(benchmarkSphereGroup.position);
  } else if (cameraFocusTarget === FOCUS_SOLAR_SYSTEM && solarSystemGroup) {
    orbitCenter.copy(solarSystemGroup.position);
  }

  const cameraOrbitRotationX = cameraFocusTarget === FOCUS_BENCHMARK
    ? benchmarkCameraRotationX
    : currentRotationX;
  const cameraOrbitRotationY = cameraFocusTarget === FOCUS_BENCHMARK
    ? benchmarkCameraRotationY
    : currentRotationY;
  const orbitX = cameraDistance * Math.sin(cameraOrbitRotationY) * Math.cos(cameraOrbitRotationX);
  const orbitY = cameraDistance * Math.sin(cameraOrbitRotationX);
  const orbitZ = cameraDistance * Math.cos(cameraOrbitRotationY) * Math.cos(cameraOrbitRotationX);

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

  if (benchmarkSphereGroup) {
    if (cameraFocusTarget === FOCUS_BENCHMARK) {
      benchmarkSphereGroup.rotation.x += (benchmarkTargetRotationX - benchmarkSphereGroup.rotation.x) * 0.12;
      benchmarkSphereGroup.rotation.y += (benchmarkTargetRotationY - benchmarkSphereGroup.rotation.y) * 0.12;
      benchmarkSphereGroup.rotation.z += (benchmarkTargetRotationZ - benchmarkSphereGroup.rotation.z) * 0.12;
    } else {
      benchmarkSphereGroup.rotation.y += 0.00018;
      benchmarkSphereGroup.rotation.x = Math.sin(time * 0.22) * 0.12;
    }
    benchmarkShaderMaterials.forEach((material, index) => {
      if (!material.uniforms) return;
      // Give each shader layer a different clock and drifting phase so the
      // gradient remains visibly asynchronous across the fractal shell.
      if (material.uniforms.uTime) material.uniforms.uTime.value = time * (1 + index * 0.075);
      if (material.uniforms.uGradientOffset) {
        material.uniforms.uGradientOffset.value = (index * 3.41 + time * (0.11 + index * 0.067)) % (Math.PI * 2);
      }
    });
  }

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

    const savedMedia = getCommentMedia(savedComment || {});
    const inputMedia = getCommentMedia({ media_type: mediaType || fileMediaType, media_url: mediaUrl });
    let localMediaUrl = savedMedia.media_url || inputMedia.media_url;
    if (!localMediaUrl && selectedFile && fileMediaType) {
      localMediaUrl = URL.createObjectURL(selectedFile);
      localCommentMediaUrls.add(localMediaUrl);
    }

    const newComment = {
      id: String(savedComment?.id || '').trim(),
      name: savedComment?.name || name,
      text: savedComment?.text || text,
      media_type: savedMedia.media_type || inputMedia.media_type || fileMediaType,
      media_url: localMediaUrl,
      index: commentQueue.length
    };
    rememberCommentMedia(newComment);
    if (selectedFile && fileMediaType) {
      await saveLocalCommentMedia(newComment, selectedFile);
    }
    // A just-submitted comment is the newest item and should appear first.
    initialComments.unshift(newComment);
    buildCommentQueue();
    activeCommentBatchNumber = -1;
    if (typeof scene !== 'undefined' && scene && typeof THREE !== 'undefined') {
      startNextCommentBatch();
    }
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
