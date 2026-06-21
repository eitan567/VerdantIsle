
    (function () {
      "use strict";

      /* ============================================================
         Verdant Isle — single-file 3D open world (Three.js r128)
         - Procedural "PBR-style" canvas textures (albedo + normal)
         - Heightmap terrain with multi-layer blending
         - Instanced trees / rocks / grass for performance
         - Animated first-person character (visible body + viewmodel arms)
         - Pointer-lock controls, gravity, jump, sprint, terrain collision
         ============================================================ */

      const WORLD = 420;          // world size (x/z span)
      const SEG = 200;          // terrain resolution
      const WATER = 2.4;          // water level
      const EYE = 3.0;          // eye height

      /* ---------- tiny deterministic value-noise / fbm ---------- */
      function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
      const rnd = mulberry32(1337);
      const perm = new Uint8Array(512);
      (function () { const p = new Uint8Array(256); for (let i = 0; i < 256; i++)p[i] = i; for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; } for (let i = 0; i < 512; i++)perm[i] = p[i & 255]; })();
      function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
      function grad(h, x, y) { const u = (h & 1) ? x : -x, v = (h & 2) ? y : -y; return u + v; }
      function noise2(x, y) {
        const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
        x -= Math.floor(x); y -= Math.floor(y);
        const u = fade(x), v = fade(y);
        const A = perm[X] + Y, B = perm[X + 1] + Y;
        return (1 + (
          (1 - v) * ((1 - u) * grad(perm[A], x, y) + u * grad(perm[B], x - 1, y)) +
          v * ((1 - u) * grad(perm[A + 1], x, y - 1) + u * grad(perm[B + 1], x - 1, y - 1))
        )) * 0.5;
      }
      function fbm(x, y, oct) { let s = 0, a = 0.5, f = 1, m = 0; for (let i = 0; i < oct; i++) { s += a * noise2(x * f, y * f); m += a; a *= 0.5; f *= 2; } return s / m; }

      /* inland lakes — carved basins, each gets its own separate water surface (set up later) */
      const LAKES = [
        { x: -64, z: 44, r: 30, depth: 7.5 },
        { x: 78, z: -52, r: 26, depth: 7.0 },
        { x: 26, z: 96, r: 24, depth: 6.5 }
      ];
      const PADS = []; // flat building pads {x,z,r,y} — heightAt levels the ground here so structures sit flush
      /* island-shaped height: falls off toward edges so it reads as an isle */
      function heightAt(x, z) {
        const nx = x / WORLD, nz = z / WORLD;
        const d = Math.sqrt(nx * nx + nz * nz) * 2;            // 0 center -> ~1 edge
        const island = Math.max(0, 1 - Math.pow(d, 2.2));  // radial mask
        let h = fbm(x * 0.012 + 50, z * 0.012 + 50, 5);          // big rolling hills
        h = Math.pow(h, 1.5);
        let hills = fbm(x * 0.035 + 12, z * 0.035 + 12, 4);      // small hills — RAISE only (0..1), so they never dig below the sea
        let mtn = fbm(x * 0.05, z * 0.05, 3);                 // fine ridges
        let elev = (h * 22 + hills * 12 + mtn * 4) * island - (1 - island) * 10;  // coast left exactly as the original
        // carve ONLY the designated inland lakes; each basin has its own floor so the ocean never shows inside it
        for (let i = 0; i < LAKES.length; i++) {
          const L = LAKES[i], dd = Math.sqrt((x - L.x) * (x - L.x) + (z - L.z) * (z - L.z));
          if (dd < L.r) { const f = 1 - dd / L.r; elev -= f * f * L.depth; if (elev < WATER + 0.6) elev = WATER + 0.6; }
        }
        // flatten building pads (level the ground toward the pad height, soft edges)
        for (let i = 0; i < PADS.length; i++) {
          const P = PADS[i], dd = Math.sqrt((x - P.x) * (x - P.x) + (z - P.z) * (z - P.z));
          if (dd < P.r) { const t = Math.min(1, Math.max(0, (P.r - dd) / 1.6)); elev = elev * (1 - t) + P.y * t; } // flat inside, 1.6u soft rim
        }
        return elev;
      }

      /* ============================================================
         RENDERER / SCENE / CAMERA
         ============================================================ */
      const canvas = document.getElementById('c');
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
      renderer.setSize(innerWidth, innerHeight);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.NoToneMapping; // keep colors vivid & saturated (ACES washes them out)

      const scene = new THREE.Scene();
      const SKY_TOP = new THREE.Color(0x6f8aa6), SKY_BOT = new THREE.Color(0xb3c8d8); // soft storybook blue-grey
      scene.fog = new THREE.Fog(0xb9cad8, 340, 980); // very gentle distance haze only
      const DEF_FOG = { color: new THREE.Color(0xb9cad8), near: 340, far: 980 }; // restored when not underwater

      const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 1000);
      const menuTransitionCam = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 1000);

      /* player rig: yaw on player, pitch on camera (child) */
      const player = new THREE.Object3D();
      player.position.set(0, 20, 0);
      scene.add(player);
      player.add(camera);
      camera.position.set(0, EYE, 0);

      /* ============================================================
         LIGHTING + SKY
         ============================================================ */
      const hemi = new THREE.HemisphereLight(0x9ec6ec, 0x4f5e2c, 0.5); // cool sky fill + warm earth bounce
      scene.add(hemi);
      const SHADOW_HALF_FPS = 110;
      const SHADOW_HALF_MENU = 180;
      const sun = new THREE.DirectionalLight(0xfff0cc, 1.4); // warm key light -> painterly warm/cool contrast
      sun.position.set(80, 120, 40);
      sun.castShadow = true;
      sun.shadow.mapSize.set(4096, 4096);
      sun.shadow.camera.near = 10; sun.shadow.camera.far = 700;
      sun.shadow.bias = -0.001;
      sun.shadow.normalBias = 0;
      scene.add(sun); scene.add(sun.target);
      const shadowLightOffset = new THREE.Vector3(80, 150, 50);
      const shadowLightDir = shadowLightOffset.clone().normalize();
      const shadowRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), shadowLightDir).normalize();
      const shadowUp = new THREE.Vector3().crossVectors(shadowLightDir, shadowRight).normalize();
      const shadowFocus = new THREE.Vector3();
      function setShadowFocus(x, y, z, half) {
        const cam = sun.shadow.camera;
        if (Math.abs(cam.right - half) > 0.5) {
          cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
          cam.updateProjectionMatrix();
        }
        const texel = (half * 2) / sun.shadow.mapSize.x;
        const rightDot = x * shadowRight.x + y * shadowRight.y + z * shadowRight.z;
        const upDot = x * shadowUp.x + y * shadowUp.y + z * shadowUp.z;
        const rightSnap = Math.round(rightDot / texel) * texel - rightDot;
        const upSnap = Math.round(upDot / texel) * texel - upDot;
        shadowFocus.set(
          x + shadowRight.x * rightSnap + shadowUp.x * upSnap,
          y + shadowRight.y * rightSnap + shadowUp.y * upSnap,
          z + shadowRight.z * rightSnap + shadowUp.z * upSnap
        );
        sun.target.position.copy(shadowFocus);
        sun.position.copy(shadowFocus).add(shadowLightOffset);
        sun.target.updateMatrixWorld();
        sun.updateMatrixWorld();
      }
      setShadowFocus(0, 0, 0, SHADOW_HALF_FPS);
      function useFrontShadowFaces(material) {
        if (Array.isArray(material)) { material.forEach(useFrontShadowFaces); return material; }
        if (material && !material.transparent && material.side !== THREE.DoubleSide) material.shadowSide = THREE.FrontSide;
        return material;
      }
      function normalizeShadowCastingMaterials(root) {
        root.traverse(obj => {
          if (obj.castShadow && obj.material) useFrontShadowFaces(obj.material);
        });
      }

      /* gradient sky dome (kept in a variable so it can be hidden underwater) */
      let skyMesh;
      (function () {
        const geo = new THREE.SphereGeometry(600, 32, 16);
        const mat = new THREE.ShaderMaterial({
          side: THREE.BackSide, depthWrite: false,
          uniforms: { top: { value: SKY_TOP }, bot: { value: SKY_BOT }, off: { value: 120.0 } },
          vertexShader: `varying vec3 vW; void main(){vW=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
          fragmentShader: `varying vec3 vW; uniform vec3 top; uniform vec3 bot; uniform float off;
      void main(){ float h=normalize(vW).y; float t=clamp((h+0.1)*1.1,0.0,1.0); gl_FragColor=vec4(mix(bot,top,t),1.0);} `
        });
        skyMesh = new THREE.Mesh(geo, mat); scene.add(skyMesh);
      })();
      const _uwBg = new THREE.Color(0x0e6a93); // solid underwater backdrop
      /* sun disc */
      (function () { const s = new THREE.Mesh(new THREE.SphereGeometry(14, 16, 16), new THREE.MeshBasicMaterial({ color: 0xfff4d0, fog: false })); s.position.copy(sun.position).multiplyScalar(3.2); scene.add(s); })();

      /* ============================================================
         PROCEDURAL TEXTURES  (albedo + matching normal map)
         ============================================================ */
      function makeCanvas(s) { const c = document.createElement('canvas'); c.width = c.height = s; return c; }
      function toTex(c, rep) { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (rep) t.repeat.set(rep, rep); t.anisotropy = renderer.capabilities.getMaxAnisotropy(); t.encoding = THREE.sRGBEncoding; return t; }
      /* build a normal map from a grayscale height canvas */
      function normalFrom(heightCanvas, strength) {
        const s = heightCanvas.width, src = heightCanvas.getContext('2d').getImageData(0, 0, s, s).data;
        const out = makeCanvas(s), ctx = out.getContext('2d'), img = ctx.createImageData(s, s);
        const H = (x, y) => { x = (x + s) % s; y = (y + s) % s; return src[(y * s + x) * 4] / 255; };
        for (let y = 0; y < s; y++)for (let x = 0; x < s; x++) {
          const dx = (H(x - 1, y) - H(x + 1, y)) * strength;
          const dy = (H(x, y - 1) - H(x, y + 1)) * strength;
          const len = Math.sqrt(dx * dx + dy * dy + 1);
          const i = (y * s + x) * 4;
          img.data[i] = (dx / len * 0.5 + 0.5) * 255;
          img.data[i + 1] = (dy / len * 0.5 + 0.5) * 255;
          img.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
          img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        const t = new THREE.CanvasTexture(out); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
      }
      function fnoiseCanvas(s, fn) { const c = makeCanvas(s), ctx = c.getContext('2d'), img = ctx.createImageData(s, s); for (let y = 0; y < s; y++)for (let x = 0; x < s; x++) { const v = fn(x / s, y / s); const i = (y * s + x) * 4; img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255; } ctx.putImageData(img, 0, 0); return c; }

      /* GRASS */
      function grassTex() {
        const s = 256, c = makeCanvas(s), ctx = c.getContext('2d');
        ctx.fillStyle = '#4f7a32'; ctx.fillRect(0, 0, s, s);
        for (let i = 0; i < 26000; i++) {
          const x = Math.random() * s, y = Math.random() * s;
          const g = 90 + Math.random() * 90 | 0, r = 40 + Math.random() * 40 | 0, b = 20 + Math.random() * 30 | 0;
          ctx.strokeStyle = `rgba(${r},${g},${b},${0.25 + Math.random() * 0.4})`;
          ctx.lineWidth = Math.random() < 0.15 ? 2 : 1;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (Math.random() - 0.5) * 3, y - 2 - Math.random() * 4); ctx.stroke();
        }
        const hc = fnoiseCanvas(s, (u, v) => 40 + fbm(u * 40, v * 40, 4) * 180);
        return { map: toTex(c, 40), normal: normalFrom(hc, 2.2) };
      }
      /* DIRT / CLIFF */
      function dirtTex() {
        const s = 256, c = makeCanvas(s), ctx = c.getContext('2d');
        for (let y = 0; y < s; y++)for (let x = 0; x < s; x++) { const n = fbm(x / s * 8, y / s * 8, 5); const r = 110 + n * 70 | 0, g = 78 + n * 55 | 0, b = 50 + n * 35 | 0; ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x, y, 1, 1); }
        for (let i = 0; i < 2200; i++) { ctx.fillStyle = `rgba(${30 + Math.random() * 40 | 0},${20 + Math.random() * 30 | 0},10,.5)`; ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 1 + Math.random() * 2); }
        const hc = fnoiseCanvas(s, (u, v) => fbm(u * 8, v * 8, 5) * 255);
        return { map: toTex(c, 40), normal: normalFrom(hc, 3.0) };
      }
      /* SAND */
      function sandTex() {
        const s = 256, c = makeCanvas(s), ctx = c.getContext('2d');
        for (let y = 0; y < s; y++)for (let x = 0; x < s; x++) { const n = fbm(x / s * 6, y / s * 6, 4); const r = 224 + n * 25 | 0, g = 204 + n * 25 | 0, b = 150 + n * 30 | 0; ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x, y, 1, 1); }
        for (let i = 0; i < 6000; i++) { ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.25})`; ctx.fillRect(Math.random() * s, Math.random() * s, 1, 1); }
        const hc = fnoiseCanvas(s, (u, v) => fbm(u * 6, v * 6, 4) * 255);
        return { map: toTex(c, 50), normal: normalFrom(hc, 1.4) };
      }
      /* ROCK */
      function rockTex() {
        const s = 256, c = makeCanvas(s), ctx = c.getContext('2d');
        for (let y = 0; y < s; y++)for (let x = 0; x < s; x++) { const n = fbm(x / s * 5, y / s * 5, 6); const v = 80 + n * 90 | 0; ctx.fillStyle = `rgb(${v},${v + 6},${v + 12})`; ctx.fillRect(x, y, 1, 1); }
        ctx.strokeStyle = 'rgba(20,20,25,.4)'; for (let i = 0; i < 40; i++) { ctx.beginPath(); ctx.moveTo(Math.random() * s, Math.random() * s); ctx.lineTo(Math.random() * s, Math.random() * s); ctx.lineWidth = Math.random() * 2; ctx.stroke(); }
        const hc = fnoiseCanvas(s, (u, v) => fbm(u * 5, v * 5, 6) * 255);
        return { map: toTex(c, 2), normal: normalFrom(hc, 3.5) };
      }
      /* BARK */
      function barkTex() {
        const s = 128, c = makeCanvas(s), ctx = c.getContext('2d');
        for (let y = 0; y < s; y++)for (let x = 0; x < s; x++) { const n = fbm(x / s * 3, y / s * 16, 4); const r = 86 + n * 50 | 0, g = 58 + n * 36 | 0, b = 34 + n * 22 | 0; ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x, y, 1, 1); }
        const t = toTex(c, 1); t.repeat.set(1, 3);
        const hc = fnoiseCanvas(s, (u, v) => fbm(u * 3, v * 16, 4) * 255); const n = normalFrom(hc, 2.5); n.repeat.set(1, 3);
        return { map: t, normal: n };
      }
      /* WATER normal */
      function waterNormal() {
        // SAME organic fbm ripples as the original, but blended across edges so the tile is seamless
        const s = 256, c = makeCanvas(s), ctx = c.getContext('2d'), img = ctx.createImageData(s, s), SC = 6;
        const tf = (u, v) => { // 4-corner blend -> seamless tileable fbm
          const a = fbm(u * SC, v * SC, 4), b = fbm((u - 1) * SC, v * SC, 4), d = fbm(u * SC, (v - 1) * SC, 4), e = fbm((u - 1) * SC, (v - 1) * SC, 4);
          return a * (1 - u) * (1 - v) + b * u * (1 - v) + d * (1 - u) * v + e * u * v;
        };
        for (let y = 0; y < s; y++)for (let x = 0; x < s; x++) { const val = tf(x / s, y / s) * 255, i = (y * s + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = val; img.data[i + 3] = 255; }
        ctx.putImageData(img, 0, 0);
        const t = normalFrom(c, 2.0); t.repeat.set(8, 8); return t;
      }

      const TEX = { grass: grassTex(), dirt: dirtTex(), sand: sandTex(), rock: rockTex(), bark: barkTex(), waterN: waterNormal() };

      /* ============================================================
         TERRAIN  (vertex-colored blend + tiled detail texture)
         ============================================================ */
      let terrainMesh;
      (function () {
        const geo = new THREE.PlaneGeometry(WORLD, WORLD, SEG, SEG);
        geo.rotateX(-Math.PI / 2);
        const pos = geo.attributes.position;
        const colors = [];
        const cGrass = new THREE.Color(0x6cb238), cGrass2 = new THREE.Color(0x4f8c2a), cDirt = new THREE.Color(0x8a6738), cDirt2 = new THREE.Color(0x6f5128), cSand = new THREE.Color(0xd8c084), cRock = new THREE.Color(0x8f9398), cFoamT = new THREE.Color(0xeafaff);
        const tmp = new THREE.Color(), earth = new THREE.Color();
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), z = pos.getZ(i);
          const h = heightAt(x, z);
          pos.setY(i, h);
          const hx = heightAt(x + 1.5, z) - heightAt(x - 1.5, z);
          const hz = heightAt(x, z + 1.5) - heightAt(x, z - 1.5);
          const slope = Math.min(1, Math.sqrt(hx * hx + hz * hz) * 0.4);
          if (h < WATER + 0.6) { tmp.copy(cSand); const fm = Math.max(0, 1 - Math.abs(h - WATER) / 0.5); tmp.lerp(cFoamT, fm * 0.55); } // wet foamy shore
          else {
            tmp.copy(cGrass).lerp(cGrass2, fbm(x * 0.09, z * 0.09, 3));            // grass tone variation
            earth.copy(cDirt).lerp(cDirt2, fbm(x * 0.12 + 9, z * 0.12 + 9, 2));        // warm bare earth
            const dirtAmt = Math.min(1, Math.max(0, (0.52 - fbm(x * 0.035, z * 0.035, 4)) * 3.2)); // painterly dirt patches
            tmp.lerp(earth, dirtAmt);
            tmp.lerp(cRock, Math.max(0, slope - 0.3));
          }
          const shade = 0.9 + fbm(x * 0.15, z * 0.15, 2) * 0.2;                        // soft AO-like variation
          colors.push(tmp.r * shade, tmp.g * shade, tmp.b * shade);
        }
        geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geo.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: 1.0, metalness: 0.0, flatShading: true
        });
        terrainMesh = new THREE.Mesh(geo, mat);
        terrainMesh.receiveShadow = true;
        scene.add(terrainMesh);
      })();

      // Level a flat building pad: registers it in heightAt (so collision matches) AND patches the terrain mesh.
      function flattenPad(cx, cz, r, y) {
        PADS.push({ x: cx, z: cz, r: r, y: y });
        const pos = terrainMesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), z = pos.getZ(i);
          if ((x - cx) * (x - cx) + (z - cz) * (z - cz) < r * r) pos.setY(i, heightAt(x, z));
        }
        pos.needsUpdate = true;
        terrainMesh.geometry.computeVertexNormals();
      }

      // collision + enterable-house registries (read by the player-movement loop)
      const colliders = [];   // simple cylinder blockers: { x, z, r }
      const houses = [];      // enterable houses: { x, z, rot, W, D, doorHalf, y, fade:[mats], door, lamp }
      const perchSpots = [];  // nice, exposed landing points for the menu parrot: roof ridges + fence-post tops
      const houseGroups = []; // house meshes, used as line-of-sight occluders for the menu camera
      function resolvePlayerCollision() {
        const pr = 0.5; let nxp = player.position.x, nzp = player.position.z;
        for (let i = 0; i < colliders.length; i++) { const c = colliders[i], dx = nxp - c.x, dz = nzp - c.z, d = Math.hypot(dx, dz), rr = c.r + pr; if (d < rr && d > 1e-4) { const k = (rr - d) / d; nxp += dx * k; nzp += dz * k; } }
        for (let i = 0; i < houses.length; i++) {
          const H = houses[i], cr = Math.cos(H.rot), sr = Math.sin(H.rot), dx = nxp - H.x, dz = nzp - H.z;
          let lx = dx * cr - dz * sr, lz = dx * sr + dz * cr;          // world -> house-local
          const hx = H.W / 2, hd = H.D / 2, dh = H.doorHalf, sw = (hx - dh) / 2;
          const walls = [[0, -hd, hx, 0.13], [-hx, 0, 0.13, hd], [hx, 0, 0.13, hd], [(hx + dh) / 2, hd, sw, 0.13], [-(hx + dh) / 2, hd, sw, 0.13]];
          for (let w = 0; w < walls.length; w++) { const a = walls[w], nx = lx - a[0], nz = lz - a[1], ox = a[2] + pr - Math.abs(nx), oz = a[3] + pr - Math.abs(nz); if (ox > 0 && oz > 0) { if (ox < oz) lx = a[0] + (nx < 0 ? -1 : 1) * (a[2] + pr); else lz = a[1] + (nz < 0 ? -1 : 1) * (a[3] + pr); } }
          nxp = H.x + lx * cr + lz * sr; nzp = H.z - lx * sr + lz * cr;  // local -> world
        }
        player.position.x = nxp; player.position.z = nzp;
      }
      function houseFloorAt(px, pz) {
        for (let i = 0; i < houses.length; i++) {
          const H = houses[i], cr = Math.cos(H.rot), sr = Math.sin(H.rot), dx = px - H.x, dz = pz - H.z, lx = dx * cr - dz * sr, lz = dx * sr + dz * cr, hw = H.W / 2, hd = H.D / 2;
          if (Math.abs(lx) < hw - 0.05 && Math.abs(lz) < hd - 0.05) return H.y + 1.0;              // interior floor
          if (Math.abs(lx) < 1.3 && lz >= hd - 0.05) {                                               // walk UP the staircase in front of the door
            const stairTop = (H.y + 1.0) - (lz - hd) * 0.844;       // follow the real stair slope down the hill
            if (stairTop > heightAt(px, pz)) return stairTop;        // stand on the steps until they meet the ground
          }
        }
        return null;
      }
      function updateHouses(dt) {
        const px = player.position.x, pz = player.position.z, py = player.position.y;
        for (let i = 0; i < houses.length; i++) {
          const H = houses[i], cr = Math.cos(H.rot), sr = Math.sin(H.rot), dx = px - H.x, dz = pz - H.z, lx = dx * cr - dz * sr, lz = dx * sr + dz * cr;
          const inside = Math.abs(lx) < H.W / 2 + 0.4 && Math.abs(lz) < H.D / 2 + 0.4 && Math.abs(py - (H.y + 1)) < 3.2;
          const dwx = H.x + Math.sin(H.rot) * (H.D / 2), dwz = H.z + Math.cos(H.rot) * (H.D / 2);
          const open = inside || ((px - dwx) * (px - dwx) + (pz - dwz) * (pz - dwz) < 25);
          H.door.rotation.y += ((open ? -1.95 : 0) - H.door.rotation.y) * Math.min(1, dt * 6);
          const op = inside ? 0.16 : 1.0;
          for (let m = 0; m < H.fade.length; m++) { const mat = H.fade[m]; mat.opacity += (op - mat.opacity) * Math.min(1, dt * 6); mat.transparent = mat.opacity < 0.98; }
          H.lamp.intensity += ((inside ? 1.6 : 0) - H.lamp.intensity) * Math.min(1, dt * 4);
        }
      }

      /* ============================================================
         WATER
         ============================================================ */
      const waterGeo = new THREE.PlaneGeometry(WORLD * 1.6, WORLD * 1.6, 64, 64);
      waterGeo.rotateX(-Math.PI / 2);
      // the original water, unchanged in look & behaviour — ONLY the normal map is now tileable (no seams).
      const waterMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.93, roughness: 0.4, metalness: 0.05,
        side: THREE.DoubleSide, normalMap: TEX.waterN, normalScale: new THREE.Vector2(0.28, 0.28)
      });
      const waterFoamU = { uTime: { value: 0 } };
      // keep the white shoreline foam (per-pixel) layered on top of the original-looking water
      waterMat.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = waterFoamU.uTime;
        sh.vertexShader = 'attribute float aDepth; varying float vDepth; varying vec3 vWorld;\n' +
          sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vDepth=aDepth; vWorld=position;\n');
        sh.fragmentShader = 'uniform float uTime; varying float vDepth; varying vec3 vWorld;\n' +
          sh.fragmentShader.replace('#include <color_fragment>',
            '#include <color_fragment>\n' +
            ' float _wxz=vWorld.x+vWorld.z;\n' +
            ' float _band=1.0-smoothstep(0.0,1.3,vDepth);\n' +
            ' float _e1=1.7+0.8*sin(uTime*1.2 + _wxz*0.05);\n' +
            ' float _c1=1.0-clamp(abs(vDepth-_e1)/0.40,0.0,1.0);\n' +
            ' float _e2=3.0+0.9*sin(uTime*0.8 - _wxz*0.04 + 2.0);\n' +
            ' float _c2=0.7*(1.0-clamp(abs(vDepth-_e2)/0.34,0.0,1.0));\n' +
            ' float _foam=clamp(max(_band,max(_c1,_c2)),0.0,1.0);\n' +
            ' diffuseColor.rgb=mix(diffuseColor.rgb, vec3(0.95,0.99,1.0), _foam);\n');
      };
      const water = new THREE.Mesh(waterGeo, waterMat);
      water.position.y = WATER; water.frustumCulled = false; scene.add(water);
      // cache base XZ + per-vertex depth (drives the shader foam); base colour is static
      const wpos = waterGeo.attributes.position, wnor = waterGeo.attributes.normal, wN = wpos.count;
      const wbx = new Float32Array(wN), wbz = new Float32Array(wN), wdep = new Float32Array(wN), wcolArr = new Float32Array(wN * 3);
      const cDeepW = new THREE.Color(0x0b4f7e), cShallowW = new THREE.Color(0x2fc1e0), wc = new THREE.Color();
      for (let i = 0; i < wN; i++) {
        const x = wpos.getX(i), z = wpos.getZ(i); wbx[i] = x; wbz[i] = z;
        const depth = WATER - heightAt(x, z); wdep[i] = depth;
        const shallow = Math.min(1, Math.max(0, (2.4 - depth) / 2.4));
        wc.copy(cDeepW).lerp(cShallowW, shallow * shallow);
        wcolArr[i * 3] = wc.r; wcolArr[i * 3 + 1] = wc.g; wcolArr[i * 3 + 2] = wc.b;
      }
      waterGeo.setAttribute('color', new THREE.Float32BufferAttribute(wcolArr, 3));
      waterGeo.setAttribute('aDepth', new THREE.Float32BufferAttribute(wdep, 1));

      /* ---- separate inland LAKES: each its own water disc, sitting above sea level in its basin ---- */
      const lakeMat = new THREE.MeshStandardMaterial({ color: 0x2f8fb0, transparent: true, opacity: 0.85, roughness: 0.22, metalness: 0.0, side: THREE.DoubleSide });
      const lakeMeshes = [];
      for (let i = 0; i < LAKES.length; i++) {
        const L = LAKES[i], rad = L.r * 0.8;
        // sample the bank all around the disc edge; the surface must sit just BELOW the lowest
        // bank point, so the water edge is always tucked under the ground (never floating over it)
        let minBank = 1e9;
        for (let a = 0; a < 12; a++) { const ang = a / 12 * 6.283, hh = heightAt(L.x + Math.cos(ang) * rad, L.z + Math.sin(ang) * rad); if (hh < minBank) minBank = hh; }
        const wy = Math.max(WATER + 1.0, minBank - 0.3);   // surface just under the lowest bank
        const disc = new THREE.Mesh(new THREE.CircleGeometry(rad, 36), lakeMat);
        disc.rotation.x = -Math.PI / 2; disc.position.set(L.x, wy, L.z); disc.renderOrder = 1;
        scene.add(disc); lakeMeshes.push({ mesh: disc, wy });
      }

      /* ============================================================
         INSTANCED VEGETATION + ROCKS
         ============================================================ */
      const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
      function placeOK(x, z, minH, maxSlope) {
        const h = heightAt(x, z); if (h < minH) return null;
        const hx = heightAt(x + 1.5, z) - heightAt(x - 1.5, z), hz = heightAt(x, z + 1.5) - heightAt(x, z - 1.5);
        if (Math.sqrt(hx * hx + hz * hz) > maxSlope) return null;
        return h;
      }

      // ---- WIND: shared uniforms + shader injection that sways instanced foliage ----
      const windUniforms = { uTime: { value: 0 }, uWind: { value: 0.22 } };
      function applyWind(mat, amp) {
        amp = amp || 1.0;
        mat.onBeforeCompile = (sh) => {
          sh.uniforms.uTime = windUniforms.uTime; sh.uniforms.uWind = windUniforms.uWind;
          sh.vertexShader = 'uniform float uTime;uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>',
            '#include <begin_vertex>\n#ifdef USE_INSTANCING\n vec4 _wp=instanceMatrix*vec4(transformed,1.0);\n float _ph=_wp.x*0.10+_wp.z*0.10;\n float _lh=clamp((transformed.y+2.6)/5.2,0.0,1.0);\n float _sw=sin(uTime*1.3+_ph)*uWind*' + amp.toFixed(2) + ';\n transformed.x+=_sw*_lh;\n transformed.z+=_sw*0.55*_lh;\n#endif\n');
        };
        mat.customProgramCacheKey = () => 'wind' + amp;
        return mat;
      }

      /* TREES — several archetypes (oak / birch / shrub) for variety, all instanced */
      (function () {
        const N = 0, kinds = { oak: [], birch: [], shrub: [] }; // old world trees off — world uses the new trees (scattered at init)
        let tries = 0;
        while ((kinds.oak.length + kinds.birch.length + kinds.shrub.length) < N && tries < N * 8) {
          tries++;
          const x = (rnd() - 0.5) * WORLD * 0.92, z = (rnd() - 0.5) * WORLD * 0.92;
          const h = placeOK(x, z, WATER + 1.5, 7); if (h === null) continue;
          const r = rnd(), k = r < 0.58 ? 'oak' : r < 0.76 ? 'birch' : 'shrub';
          const s = k === 'oak' ? 1.05 + rnd() * 1.2 : k === 'birch' ? 0.9 + rnd() * 0.55 : 0.5 + rnd() * 0.45;
          kinds[k].push({ x, z, h, s, r: rnd() * Math.PI * 2 });
        }
        // shared gradient canopy blob (dark underside -> bright crown)
        const ballG = new THREE.IcosahedronGeometry(2.6, 1);
        (function () { const p = ballG.attributes.position, cs = []; let mn = 1e9, mx = -1e9; for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < mn) mn = y; if (y > mx) mx = y; } for (let i = 0; i < p.count; i++) { const tt = (p.getY(i) - mn) / (mx - mn); const s = 0.56 + 0.6 * tt; cs.push(s, s, s); } ballG.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3)); })();
        const foliMat = applyWind(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, flatShading: true }), 1.0);
        const col = new THREE.Color();

        function buildKind(arr, trunkG, trunkMat, blobs, pal, accent) {
          if (!arr.length) return;
          const trunk = new THREE.InstancedMesh(trunkG, trunkMat, arr.length); trunk.castShadow = trunk.receiveShadow = true;
          const layers = blobs.map(() => { const L = new THREE.InstancedMesh(ballG, foliMat, arr.length); L.castShadow = true; return L; });
          arr.forEach((d, i) => {
            _q.setFromAxisAngle(_up, d.r);
            _p.set(d.x, d.h, d.z); _s.set(d.s, d.s, d.s); _m.compose(_p, _q, _s); trunk.setMatrixAt(i, _m);
            const base = (accent && rnd() < 0.08) ? accent[(rnd() * accent.length) | 0] : pal[(rnd() * pal.length) | 0];
            col.setHex(base).offsetHSL(0, (rnd() - 0.5) * 0.05, (rnd() - 0.5) * 0.05);
            blobs.forEach((b, li) => { _p.set(d.x + b[0] * d.s, d.h + b[1] * d.s, d.z + b[2] * d.s); _s.set(d.s * b[3], d.s * b[3] * (b[4] || 1), d.s * b[3]); _m.compose(_p, _q, _s); layers[li].setMatrixAt(i, _m); layers[li].setColorAt(i, col); });
          });
          layers.forEach(L => { L.instanceColor.needsUpdate = true; });
          scene.add(trunk, ...layers);
        }

        // OAK / BROADLEAF — thick trunk, big round bright crown (the hero tree)
        const tgOak = new THREE.CylinderGeometry(0.42, 0.74, 5.0, 8); tgOak.translate(0, 2.5, 0);
        buildKind(kinds.oak, tgOak, new THREE.MeshStandardMaterial({ color: 0x6f4a29, roughness: 1, flatShading: true }),
          [[0, 5.6, 0, 1.8, 1.0], [0.75, 6.9, -0.4, 1.0, 1.0], [-0.6, 6.7, 0.45, 0.9, 1.0], [0.1, 7.9, 0.1, 0.6, 1.0]],
          [0x5cb43a, 0x50a832, 0x67c244, 0x58ad36, 0x6dc24a, 0x46992c], [0xe07a1f, 0xd9641f]);
        // BIRCH — slim pale trunk, tall light canopy
        const tgBirch = new THREE.CylinderGeometry(0.16, 0.24, 6.6, 7); tgBirch.translate(0, 3.3, 0);
        buildKind(kinds.birch, tgBirch, new THREE.MeshStandardMaterial({ color: 0xdad4c2, roughness: 0.9, flatShading: true }),
          [[0, 6.7, 0, 0.95, 1.3], [0.3, 7.7, 0.2, 0.66, 1.0]],
          [0x86c24a, 0x76b840, 0x93cf52, 0x9ed35a], null);
        // SHRUB-TREE — short, small round
        const tgShrub = new THREE.CylinderGeometry(0.22, 0.3, 2.0, 6); tgShrub.translate(0, 1.0, 0);
        buildKind(kinds.shrub, tgShrub, new THREE.MeshStandardMaterial({ color: 0x7c5230, roughness: 1, flatShading: true }),
          [[0, 2.2, 0, 0.95, 0.92], [0.4, 2.9, 0, 0.6, 1.0]],
          [0x57a83a, 0x4e9a34, 0x62b042], null);
      })();

      /* ROCKS — two shapes, varied grey shades, sizes & flatness */
      (function () {
        const N = 200, data = []; let tries = 0;
        while (data.length < N && tries < N * 8) { tries++; const x = (rnd() - 0.5) * WORLD * 0.96, z = (rnd() - 0.5) * WORLD * 0.96; const h = placeOK(x, z, WATER - 0.5, 99); if (h === null) continue; data.push({ x, z, h, s: 0.45 + rnd() * 2.6, r: rnd() * 6.28, flat: 0.6 + rnd() * 0.6, geo: rnd() < 0.5 ? 0 : 1 }); }
        const gA = new THREE.DodecahedronGeometry(1, 0), gB = new THREE.IcosahedronGeometry(1, 0);
        [gA, gB].forEach(g => { const p = g.attributes.position, cs = []; let mn = 1e9, mx = -1e9; for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < mn) mn = y; if (y > mx) mx = y; } for (let i = 0; i < p.count; i++) { const tt = (p.getY(i) - mn) / (mx - mn); const s = 0.7 + 0.4 * tt; cs.push(s, s, s); } g.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3)); });
        const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, flatShading: true });
        const shades = [0x8d9298, 0x9aa0a6, 0xa7adb2, 0x7e848a, 0x868d92], col = new THREE.Color();
        function build(arr, g) {
          if (!arr.length) return; const im = new THREE.InstancedMesh(g, mat, arr.length); im.castShadow = im.receiveShadow = true;
          arr.forEach((d, i) => { _q.setFromEuler(new THREE.Euler(rnd() * 0.6, d.r, rnd() * 0.6)); _p.set(d.x, d.h + d.s * 0.25, d.z); _s.set(d.s, d.s * d.flat, d.s); _m.compose(_p, _q, _s); im.setMatrixAt(i, _m); col.setHex(shades[(rnd() * shades.length) | 0]).offsetHSL(0, 0, (rnd() - 0.5) * 0.05); im.setColorAt(i, col); });
          im.instanceColor.needsUpdate = true; scene.add(im);
        }
        build(data.filter(d => d.geo === 0), gA); build(data.filter(d => d.geo === 1), gB);
        data.forEach(d => { if (d.s > 0.9) colliders.push({ x: d.x, z: d.z, r: d.s * 0.7 }); });  // bump into the bigger rocks
      })();

      /* BUSHES — chunky low-poly green clusters (3 lobes each) */
      (function () {
        const N = 220, data = []; let tries = 0;
        while (data.length < N && tries < N * 5) { tries++; const x = (rnd() - 0.5) * WORLD * 0.9, z = (rnd() - 0.5) * WORLD * 0.9; const h = placeOK(x, z, WATER + 1.2, 4); if (h === null) continue; data.push({ x, z, h, s: 0.55 + rnd() * 1.05, r: rnd() * 6.28 }); }
        const g = new THREE.IcosahedronGeometry(1, 0); // faceted blob
        (function () { const p = g.attributes.position, cs = []; let mn = 1e9, mx = -1e9; for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < mn) mn = y; if (y > mx) mx = y; } for (let i = 0; i < p.count; i++) { const tt = (p.getY(i) - mn) / (mx - mn); const s = 0.6 + 0.55 * tt; cs.push(s, s, s); } g.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3)); })();
        const greens = [0x55993a, 0x60a440, 0x4e9034, 0x66aa46, 0x4a8a30, 0x3f7e2a, 0x6fb049, 0x518f38];
        const col = new THREE.Color();
        const lobes = [[0, 0, 0, 1.0], [0.72, -0.18, 0.22, 0.72], [-0.62, -0.12, -0.3, 0.66]];
        const meshes = lobes.map(() => new THREE.InstancedMesh(g, applyWind(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95, flatShading: true }), 0.8), data.length));
        data.forEach((d, i) => {
          col.setHex(greens[(rnd() * greens.length) | 0]).offsetHSL(0, 0, (rnd() - 0.5) * 0.05);
          lobes.forEach((lo, li) => {
            _q.setFromAxisAngle(_up, d.r);
            _p.set(d.x + lo[0] * d.s, d.h + 0.8 * d.s + lo[1] * d.s, d.z + lo[2] * d.s);
            _s.set(d.s * lo[3], d.s * lo[3] * 0.92, d.s * lo[3]);
            _m.compose(_p, _q, _s); meshes[li].setMatrixAt(i, _m); meshes[li].setColorAt(i, col);
          });
        });
        meshes.forEach(m => { m.instanceColor.needsUpdate = true; m.castShadow = true; m.receiveShadow = true; scene.add(m); });
      })();

      /* FLOWERS (color pops) */
      (function () {
        const N = 480, data = []; let tries = 0; const cols = [0xffd166, 0xef476f, 0xffffff, 0xff8800, 0xfee440, 0xe23b5a];
        while (data.length < N && tries < N * 5) { tries++; const x = (rnd() - 0.5) * WORLD * 0.85, z = (rnd() - 0.5) * WORLD * 0.85; const h = placeOK(x, z, WATER + 1.5, 3); if (h === null) continue; data.push({ x, z, h, c: cols[(rnd() * cols.length) | 0] }); }
        const g = new THREE.SphereGeometry(0.22, 6, 5);
        const stemG = new THREE.CylinderGeometry(0.03, 0.03, 0.5, 4); stemG.translate(0, 0.25, 0);
        const stemMat = new THREE.MeshStandardMaterial({ color: 0x3f8a2e, roughness: 1, flatShading: true });
        // group by color into instanced meshes (+ shared stems)
        const byCol = {}; data.forEach(d => { (byCol[d.c] = byCol[d.c] || []).push(d); });
        const stems = new THREE.InstancedMesh(stemG, stemMat, data.length); data.forEach((d, i) => { _q.identity(); _p.set(d.x, d.h, d.z); _s.set(1, 1, 1); _m.compose(_p, _q, _s); stems.setMatrixAt(i, _m); }); scene.add(stems);
        Object.keys(byCol).forEach(c => { const arr = byCol[c]; const im = new THREE.InstancedMesh(g, applyWind(new THREE.MeshStandardMaterial({ color: +c, roughness: 0.8, flatShading: true }), 1.4), arr.length); arr.forEach((d, i) => { _q.identity(); _p.set(d.x, d.h + 0.55, d.z); _s.set(1, 1, 1); _m.compose(_p, _q, _s); im.setMatrixAt(i, _m); }); scene.add(im); });
      })();

      /* ============================================================
         DETAILS — pine trees, mushrooms, stumps, logs (all instanced)
         ============================================================ */
      (function () {
        // --- pine trees (stacked cones) ---
        const pN = 0, pd = []; let pt = 0; // classic pines off by default
        while (pd.length < pN && pt < pN * 6) { pt++; const x = (rnd() - 0.5) * WORLD * 0.9, z = (rnd() - 0.5) * WORLD * 0.9; const h = placeOK(x, z, WATER + 1.5, 6); if (h === null) continue; pd.push({ x, z, h, s: 0.85 + rnd() * 1.25, r: rnd() * 6.28, tall: rnd() < 0.5 }); }
        const pTrunkG = new THREE.CylinderGeometry(0.22, 0.34, 2.2, 6); pTrunkG.translate(0, 1.1, 0);
        const pConeG = new THREE.ConeGeometry(1.7, 3.7, 8);
        (function () { const p = pConeG.attributes.position, cs = []; let mn = 1e9, mx = -1e9; for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < mn) mn = y; if (y > mx) mx = y; } for (let i = 0; i < p.count; i++) { const tt = (p.getY(i) - mn) / (mx - mn); const s = 0.6 + 0.5 * tt; cs.push(s, s, s); } pConeG.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3)); })();
        const pConeMat = applyWind(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, flatShading: true }), 0.5);
        const pTrunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a28, roughness: 1, flatShading: true });
        const pTr = new THREE.InstancedMesh(pTrunkG, pTrunkMat, pd.length);
        const pc1 = new THREE.InstancedMesh(pConeG, pConeMat, pd.length), pc2 = new THREE.InstancedMesh(pConeG, pConeMat, pd.length), pc3 = new THREE.InstancedMesh(pConeG, pConeMat, pd.length);
        [pTr, pc1, pc2, pc3].forEach(m => { m.castShadow = true; m.receiveShadow = true; });
        // teal / blue-green firs — clearly distinct from the grass-green broadleaf trees
        const pineGreens = [0x2f7d6b, 0x2b8a72, 0x357f5e, 0x3a9a82, 0x47977a, 0x256b5c], pcol = new THREE.Color();
        pd.forEach((d, i) => {
          _q.setFromAxisAngle(_up, d.r);
          const ty = d.tall ? 1.45 : 1.05; // some much taller, slimmer firs
          _p.set(d.x, d.h, d.z); _s.set(d.s, d.s, d.s); _m.compose(_p, _q, _s); pTr.setMatrixAt(i, _m);
          _p.set(d.x, d.h + 2.2 * d.s, d.z); _s.set(d.s, d.s * ty, d.s); _m.compose(_p, _q, _s); pc1.setMatrixAt(i, _m);
          _p.set(d.x, d.h + (3.5 * ty) * d.s, d.z); _s.set(d.s * 0.78, d.s * 0.9 * ty, d.s * 0.78); _m.compose(_p, _q, _s); pc2.setMatrixAt(i, _m);
          _p.set(d.x, d.h + (4.7 * ty) * d.s, d.z); _s.set(d.s * 0.55, d.s * 0.85 * ty, d.s * 0.55); _m.compose(_p, _q, _s); pc3.setMatrixAt(i, _m);
          pcol.setHex(pineGreens[(rnd() * pineGreens.length) | 0]).offsetHSL(0, (rnd() - 0.5) * 0.04, (rnd() - 0.5) * 0.05);
          pc1.setColorAt(i, pcol); pc2.setColorAt(i, pcol); pc3.setColorAt(i, pcol);
        });
        if (pc1.instanceColor) { pc1.instanceColor.needsUpdate = true; pc2.instanceColor.needsUpdate = true; pc3.instanceColor.needsUpdate = true; }
        scene.add(pTr, pc1, pc2, pc3);

        // --- mushrooms (red cap + pale stem) ---
        const mN = 70, md = []; let mt = 0;
        while (md.length < mN && mt < mN * 5) { mt++; const x = (rnd() - 0.5) * WORLD * 0.85, z = (rnd() - 0.5) * WORLD * 0.85; const h = placeOK(x, z, WATER + 1.5, 3.5); if (h === null) continue; md.push({ x, z, h, s: 0.6 + rnd() * 0.9, r: rnd() * 6.28 }); }
        const capG = new THREE.IcosahedronGeometry(0.32, 1), capMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.7, flatShading: true });
        const stG = new THREE.CylinderGeometry(0.09, 0.11, 0.34, 6); stG.translate(0, 0.17, 0); const stMat = new THREE.MeshStandardMaterial({ color: 0xede2cf, roughness: 0.9, flatShading: true });
        const caps = new THREE.InstancedMesh(capG, capMat, md.length), mst = new THREE.InstancedMesh(stG, stMat, md.length); caps.castShadow = mst.castShadow = true;
        md.forEach((d, i) => {
          _q.setFromAxisAngle(_up, d.r);
          _p.set(d.x, d.h + 0.34 * d.s, d.z); _s.set(d.s, d.s * 0.7, d.s); _m.compose(_p, _q, _s); caps.setMatrixAt(i, _m);
          _p.set(d.x, d.h, d.z); _s.set(d.s, d.s, d.s); _m.compose(_p, _q, _s); mst.setMatrixAt(i, _m);
        });
        scene.add(caps, mst);

        // --- stumps + lying logs ---
        const sN = 70, sd = []; let st = 0;
        while (sd.length < sN && st < sN * 6) { st++; const x = (rnd() - 0.5) * WORLD * 0.88, z = (rnd() - 0.5) * WORLD * 0.88; const h = placeOK(x, z, WATER + 1.5, 3); if (h === null) continue; sd.push({ x, z, h, r: rnd() * 6.28, log: rnd() < 0.45, s: 0.7 + rnd() * 0.6 }); }
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 1, flatShading: true });
        const ringMat = new THREE.MeshStandardMaterial({ color: 0xb08a56, roughness: 1, flatShading: true });
        const stumps = sd.filter(d => !d.log), logs = sd.filter(d => d.log);
        if (stumps.length) {
          const sm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.58, 0.8, 9), woodMat, stumps.length);
          const sc = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.47, 0.47, 0.08, 9), ringMat, stumps.length); sm.castShadow = true;
          stumps.forEach((d, i) => { _q.setFromAxisAngle(_up, d.r); _p.set(d.x, d.h + 0.4 * d.s, d.z); _s.set(d.s, d.s, d.s); _m.compose(_p, _q, _s); sm.setMatrixAt(i, _m); _p.set(d.x, d.h + 0.81 * d.s, d.z); _m.compose(_p, _q, _s); sc.setMatrixAt(i, _m); });
          scene.add(sm, sc);
        }
        if (logs.length) {
          const lg = new THREE.CylinderGeometry(0.34, 0.34, 2.6, 9); lg.rotateZ(Math.PI / 2); const lm = new THREE.InstancedMesh(lg, woodMat, logs.length); lm.castShadow = true;
          logs.forEach((d, i) => { _q.setFromAxisAngle(_up, d.r); _p.set(d.x, d.h + 0.18, d.z); _s.set(d.s, d.s, d.s); _m.compose(_p, _q, _s); lm.setMatrixAt(i, _m); }); scene.add(lm);
        }
      })();

      /* PALMS — beach trees (slim trunk + splayed fronds) */
      (function () {
        const N = 0, pd = []; let t = 0; // classic palms off by default
        while (pd.length < N && t < N * 9) { t++; const x = (rnd() - 0.5) * WORLD * 0.96, z = (rnd() - 0.5) * WORLD * 0.96; const h = heightAt(x, z); if (h < WATER + 0.1 || h > WATER + 2.4) continue; const hx = heightAt(x + 1.5, z) - heightAt(x - 1.5, z), hz = heightAt(x, z + 1.5) - heightAt(x, z - 1.5); if (Math.hypot(hx, hz) > 2) continue; pd.push({ x, z, h, s: 0.9 + rnd() * 0.7, r: rnd() * 6.28 }); }
        if (!pd.length) return;
        const trunkG = new THREE.CylinderGeometry(0.15, 0.26, 6.4, 6); trunkG.translate(0, 3.2, 0);
        const trunk = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x9c7c46, roughness: 1, flatShading: true }), pd.length); trunk.castShadow = trunk.receiveShadow = true;
        // frond: long flat blade; base at origin, tip at +Y, drooping down/out
        const frondG = new THREE.ConeGeometry(0.42, 3.9, 4); frondG.scale(1, 1, 0.14); frondG.translate(0, 1.95, 0);
        const frondMat = applyWind(new THREE.MeshStandardMaterial({ color: 0x3f8f3a, roughness: 0.85, flatShading: true, side: THREE.DoubleSide }), 1.8);
        const NF = 8, fronds = []; for (let f = 0; f < NF; f++) { const F = new THREE.InstancedMesh(frondG, frondMat, pd.length); F.castShadow = true; fronds.push(F); }
        const tiltQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -2.2); // arch outward then droop down
        pd.forEach((d, i) => {
          _q.setFromAxisAngle(_up, d.r); _p.set(d.x, d.h, d.z); _s.set(d.s, d.s, d.s); _m.compose(_p, _q, _s); trunk.setMatrixAt(i, _m);
          for (let f = 0; f < NF; f++) { _q.setFromAxisAngle(_up, d.r + f / NF * 6.283); _q.multiply(tiltQ); _p.set(d.x, d.h + 6.35 * d.s, d.z); _s.set(d.s, d.s, d.s); _m.compose(_p, _q, _s); fronds[f].setMatrixAt(i, _m); }
        });
        scene.add(trunk, ...fronds);
      })();

      /* FRUIT TREES — round canopy dotted with red fruit */
      (function () {
        const N = 0, fd = []; let t = 0; // classic fruit trees off by default
        while (fd.length < N && t < N * 9) { t++; const x = (rnd() - 0.5) * WORLD * 0.85, z = (rnd() - 0.5) * WORLD * 0.85; const h = placeOK(x, z, WATER + 1.8, 5); if (h === null) continue; fd.push({ x, z, h, s: 0.85 + rnd() * 0.5, r: rnd() * 6.28 }); }
        if (!fd.length) return;
        const trunkG = new THREE.CylinderGeometry(0.3, 0.5, 4, 7); trunkG.translate(0, 2, 0);
        const ballG = new THREE.IcosahedronGeometry(2.4, 1);
        (function () { const p = ballG.attributes.position, cs = []; let mn = 1e9, mx = -1e9; for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < mn) mn = y; if (y > mx) mx = y; } for (let i = 0; i < p.count; i++) { const tt = (p.getY(i) - mn) / (mx - mn); const s = 0.56 + 0.6 * tt; cs.push(s, s, s); } ballG.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3)); })();
        const leafMat = applyWind(new THREE.MeshStandardMaterial({ color: 0x4f9c34, vertexColors: true, roughness: 0.9, flatShading: true }), 1.0);
        const trunk = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x6f4a29, roughness: 1, flatShading: true }), fd.length);
        const c1 = new THREE.InstancedMesh(ballG, leafMat, fd.length), c2 = new THREE.InstancedMesh(ballG, leafMat, fd.length);
        trunk.castShadow = c1.castShadow = c2.castShadow = true;
        const FR = 7, fruit = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.22, 0), new THREE.MeshStandardMaterial({ color: 0xe23b2e, roughness: 0.6, flatShading: true }), fd.length * FR); fruit.castShadow = true;
        let fi = 0;
        fd.forEach((d, i) => {
          _q.setFromAxisAngle(_up, d.r);
          _p.set(d.x, d.h, d.z); _s.set(d.s, d.s, d.s); _m.compose(_p, _q, _s); trunk.setMatrixAt(i, _m);
          _p.set(d.x, d.h + 4.3 * d.s, d.z); _s.set(d.s * 1.15, d.s * 1.1, d.s * 1.15); _m.compose(_p, _q, _s); c1.setMatrixAt(i, _m);
          _p.set(d.x + 0.4 * d.s, d.h + 5.2 * d.s, d.z); _s.set(d.s * 0.78, d.s * 0.78, d.s * 0.78); _m.compose(_p, _q, _s); c2.setMatrixAt(i, _m);
          for (let k = 0; k < FR; k++) { const aa = rnd() * 6.283, rr = (1.3 + rnd() * 0.7) * d.s; _q.identity(); _p.set(d.x + Math.cos(aa) * rr, d.h + (3.7 + rnd() * 1.5) * d.s, d.z + Math.sin(aa) * rr); _s.set(d.s, d.s, d.s); _m.compose(_p, _q, _s); fruit.setMatrixAt(fi++, _m); }
        });
        scene.add(trunk, c1, c2, fruit);
      })();

      /* ============================================================
         COLLECTIBLE CRYSTALS
         ============================================================ */
      const crystals = [];
      (function () {
        const N = 18; let tries = 0;
        const g = new THREE.OctahedronGeometry(0.6, 0);
        // one shared self-illuminated material — NO per-crystal lights (those forced a full
        // shader recompile every time one was collected, causing the multi-second freeze)
        const mat = new THREE.MeshStandardMaterial({ color: 0x4fd6ee, emissive: 0x39c8e0, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.0 });
        while (crystals.length < N && tries < N * 10) {
          tries++; const x = (rnd() - 0.5) * WORLD * 0.85, z = (rnd() - 0.5) * WORLD * 0.85; const h = placeOK(x, z, WATER + 1.5, 6); if (h === null) continue;
          const m = new THREE.Mesh(g, mat); m.position.set(x, h + 1.6, z); m.castShadow = true;
          scene.add(m); crystals.push({ mesh: m, baseY: h + 1.6, got: false });
        }
        document.getElementById('total').textContent = crystals.length;
      })();

      /* ============================================================
         VILLAGE — cottages, fences, low-poly clouds + smoke
         ============================================================ */
      const clouds = []; const smoke = [];
      let worldMakeHouse = null;   // exposed so the Builder tool can place the same enterable house
      (function () {
        const wallMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.95, flatShading: true });
        const gableMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.95, flatShading: true, side: THREE.DoubleSide });
        const wallMat2 = new THREE.MeshStandardMaterial({ color: 0xe0863a, roughness: 0.95, flatShading: true });
        const stoneMat = new THREE.MeshStandardMaterial({ color: 0xb9bdc2, roughness: 1, flatShading: true });
        const roofMat = new THREE.MeshStandardMaterial({ color: 0xd6452f, roughness: 0.9, flatShading: true });
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x8a5a2c, roughness: 1, flatShading: true });
        const doorMat = new THREE.MeshStandardMaterial({ color: 0x6e3f1e, roughness: 1, flatShading: true });
        const glassMat = new THREE.MeshStandardMaterial({ color: 0xa6dcf0, emissive: 0x2a4a5a, emissiveIntensity: 0.3, roughness: 0.3, metalness: 0.1, flatShading: true });
        const smokeMat = new THREE.MeshStandardMaterial({ color: 0xcfd4d8, roughness: 1, flatShading: true });

        function box(w, h, d, mat, x, y, z, parent) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; }
        function gableEnd(w, hh, mat, z, parent) { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute([-w / 2, 0, 0, w / 2, 0, 0, 0, hh, 0], 3)); geo.setIndex([0, 1, 2]); geo.computeVertexNormals(); const m = new THREE.Mesh(geo, mat); m.position.z = z; m.castShadow = true; parent.add(m); return m; }

        const fWood = new THREE.MeshStandardMaterial({ color: 0x9c6b3a, roughness: 0.9, flatShading: true });
        const fCloth = new THREE.MeshStandardMaterial({ color: 0x4a7a9c, roughness: 0.9, flatShading: true });
        const fWhite = new THREE.MeshStandardMaterial({ color: 0xeae2d0, roughness: 0.9, flatShading: true });
        const fRug = new THREE.MeshStandardMaterial({ color: 0xb04a3a, roughness: 1, flatShading: true });
        const fFloor = new THREE.MeshStandardMaterial({ color: 0xb98a55, roughness: 1, flatShading: true });
        function makeHouse(x, z, h, rot) {
          flattenPad(x, z, 5.5, h);   // level the ground under the house first
          const g = new THREE.Group(); g.position.set(x, h, z); g.rotation.y = rot; scene.add(g); houseGroups.push(g);
          // sized for the tall player (eye height 3.0): roomy footprint, ~3.8 door, ~5 ceiling
          const W = 9, D = 8, th = 0.24, doorHalf = 1.35;
          const FLOOR = 1.0, wallH = 5.0, wallY = FLOOR + wallH / 2, wallTop = FLOOR + wallH; // walls 1.0 -> 6.0
          const hh = 3.0, doorH = 3.8;                            // gable rise; clear door opening height
          const iw = W * 0.94, id = D * 0.94, hx = iw / 2, hd = id / 2;
          const wm = wallMat.clone(), rm = roofMat.clone(), gm = gableMat.clone(); // per-house mats so only THIS house fades
          box(W * 1.05, 7.0, D * 1.05, stoneMat, 0, -2.5, 0, g);  // deep stone foundation (top at +1)
          box(iw, 0.2, id, fFloor, 0, FLOOR, 0, g);               // interior floor (top ~1.1)
          // hollow walls so the player can actually be inside
          box(iw, wallH, th, wm, 0, wallY, -hd, g);               // back
          box(th, wallH, id, wm, -hx, wallY, 0, g);               // left
          box(th, wallH, id, wm, hx, wallY, 0, g);                // right
          const segW = hx - doorHalf;
          box(segW, wallH, th, wm, (hx + doorHalf) / 2, wallY, hd, g);   // front (right of door)
          box(segW, wallH, th, wm, -(hx + doorHalf) / 2, wallY, hd, g);  // front (left of door)
          const lintelH = wallTop - (FLOOR + doorH);
          box(doorHalf * 2, lintelH, th, wm, 0, FLOOR + doorH + lintelH / 2, hd, g); // lintel above the door
          const geF = gableEnd(iw, hh, gm, hd, g); geF.position.y = wallTop;   // gables fill wall-top -> roof peak
          const geB = gableEnd(iw, hh, gm, -hd, g); geB.position.y = wallTop;
          const ang = Math.atan2(hh, W / 2), slab = Math.hypot(W / 2, hh) + 0.6;
          const rl = box(slab, 0.34, D * 1.24, rm, -W / 4, wallTop + hh / 2, 0, g); rl.rotation.z = ang;
          const rr = box(slab, 0.34, D * 1.24, rm, W / 4, wallTop + hh / 2, 0, g); rr.rotation.z = -ang;
          // door on a hinge (opens when you approach) — fills the opening
          const doorPivot = new THREE.Group(); doorPivot.position.set(-doorHalf, FLOOR, hd); g.add(doorPivot);
          box(doorHalf * 1.96, doorH - 0.05, 0.14, doorMat, doorHalf, (doorH - 0.05) / 2, 0, doorPivot); // panel fills the whole opening
          box(0.14, 0.5, 0.14, woodMat, doorHalf * 1.75, doorH * 0.5, 0.06, doorPivot); // handle
          // door frame trim
          box(0.16, doorH + 0.1, 0.18, woodMat, -doorHalf, FLOOR + doorH / 2, hd, g);
          box(0.16, doorH + 0.1, 0.18, woodMat, doorHalf, FLOOR + doorH / 2, hd, g);
          box(doorHalf * 2 + 0.3, 0.2, 0.2, woodMat, 0, FLOOR + doorH, hd, g);
          // windows (large, at the tall player's eye level)
          box(1.6, 1.7, 0.08, glassMat, (hx + doorHalf) / 2, 3.7, hd + 0.02, g);
          box(1.6, 1.7, 0.08, glassMat, -(hx + doorHalf) / 2, 3.7, hd + 0.02, g);
          box(0.08, 1.7, 1.8, glassMat, hx + 0.02, 3.7, -1.4, g);
          box(0.08, 1.7, 1.8, glassMat, -hx - 0.02, 3.7, 1.4, g);
          box(1.8, 1.7, 0.08, glassMat, 1.6, 3.7, -hd - 0.02, g);
          // ---- furnished interior ----
          box(2.4, 0.7, 3.2, fWood, -hx + 1.7, 1.45, -hd + 2.3, g); box(2.2, 0.5, 3.0, fWhite, -hx + 1.7, 2.0, -hd + 2.3, g); box(0.9, 0.4, 1.9, fCloth, -hx + 1.7, 2.3, -hd + 1.0, g); // bed + pillow
          box(2.0, 0.2, 2.0, fWood, hx - 2.5, 2.3, hd - 2.9, g); for (const lx of [-0.8, 0.8]) for (const lz of [-0.8, 0.8]) box(0.18, 1.2, 0.18, fWood, hx - 2.5 + lx, 1.7, hd - 2.9 + lz, g); // dining table + legs
          box(0.8, 0.9, 0.8, fCloth, hx - 1.2, 1.55, hd - 2.9, g); box(0.8, 0.9, 0.8, fCloth, hx - 3.8, 1.55, hd - 2.9, g);   // chairs
          box(3.2, 1.5, 1.0, fWhite, hx - 1.9, 1.85, -hd + 1.0, g); box(3.2, 0.16, 1.0, fWood, hx - 1.9, 2.68, -hd + 1.0, g); // kitchen counter
          box(3.8, 0.05, 3.2, fRug, -0.4, 1.13, 0.6, g);                                                                       // rug
          const lamp = new THREE.PointLight(0xffd9a0, 0.0, 14); lamp.position.set(0, 5.4, 0); g.add(lamp);                     // warm interior light
          // chimney + smoke (on the new, taller roof)
          box(0.85, 2.2, 0.85, wallMat2, W * 0.22, 7.7, -0.9, g);
          for (let i = 0; i < 4; i++) { const p = box(0.46, 0.46, 0.46, smokeMat, W * 0.22, 9.0 + i * 0.8, -0.9, g); p.rotation.set(0.6, 0.6, 0); smoke.push({ mesh: p, baseY: 9.0 + i * 0.8, phase: i * 1.3 }); }
          // ADAPTIVE staircase (each step reaches the real ground; low last step)
          {
            const fz = D / 2, topY = 1.0, sd = 0.45, sh = 0.38;
            const lg = (zz) => heightAt(x + Math.sin(rot) * zz, z + Math.cos(rot) * zz) - h;
            let nS = 2;
            for (let i = 1; i < 40; i++) { nS = i + 1; if (topY - (i + 1) * sh <= lg(fz + 0.05 + i * sd) + 0.42) break; }
            let lastZ = fz, lastG = lg(fz);
            for (let i = 0; i < nS; i++) {
              const sz = fz + 0.05 + i * sd, treadY = topY - (i + 1) * sh, gwi = lg(sz);
              const bottom = Math.min(gwi - 0.1, treadY - sh), hgt = treadY - bottom;
              box(1.8, hgt, sd + 0.1, stoneMat, 0, (treadY + bottom) / 2, sz, g);
              lastZ = sz; lastG = gwi;
            }
            for (const side of [-1, 1]) {
              box(0.12, 0.9, 0.12, woodMat, side * 0.92, topY + 0.45, fz + 0.1, g);
              box(0.12, 0.9, 0.12, woodMat, side * 0.92, lastG + 0.45, lastZ, g);
              const z0 = fz + 0.1, y0 = topY + 0.9, z1 = lastZ, y1 = lastG + 0.9, dz = z1 - z0, dy = y1 - y0, len = Math.hypot(dz, dy);
              const r = box(0.1, 0.1, len, woodMat, side * 0.92, (y0 + y1) / 2, (z0 + z1) / 2, g); r.rotation.x = Math.atan2(-dy, dz);
            }
          }
          houses.push({ x, z, rot, W: iw, D: id, doorHalf, y: h, fade: [wm, rm, gm], door: doorPivot, lamp, open: false });
          // roof ridge + the two gable apexes -> clean, exposed perches for the menu parrot
          const ridgeY = h + wallTop + hh + 0.1, sr2 = Math.sin(rot), cr2 = Math.cos(rot);
          perchSpots.push({ x, y: ridgeY, z });
          perchSpots.push({ x: x + hd * sr2, y: ridgeY, z: z + hd * cr2 });
          perchSpots.push({ x: x - hd * sr2, y: ridgeY, z: z - hd * cr2 });
          return g;
        }
        worldMakeHouse = makeHouse;   // let buildAt() reuse this enterable house

        function fence(x, z, len, dir) { // dir 0 -> along +x, 1 -> along +z ; posts + rails follow the ground
          const g = new THREE.Group(); scene.add(g);
          const n = Math.max(2, Math.round(len / 1.1)), step = len / n;
          for (let i = 0; i <= n; i++) {
            const px = dir ? x : x + i * step, pz = dir ? z + i * step : z, py = heightAt(px, pz);
            box(0.17, 1.7, 0.17, woodMat, px, py + 0.55, pz, g);   // post (sunk a little, so it always meets the ground)
            colliders.push({ x: px, z: pz, r: 0.45 });             // fence blocks the player
            perchSpots.push({ x: px, y: py + 1.45, z: pz });       // post top -> menu parrot perch
            if (i < n) {
              const px2 = dir ? x : x + (i + 1) * step, pz2 = dir ? z + (i + 1) * step : z, py2 = heightAt(px2, pz2);
              const mx = (px + px2) / 2, mz = (pz + pz2) / 2, my = (py + py2) / 2, dy = py2 - py, sl = Math.hypot(step, dy);
              for (const ry of [1.05, 0.55]) {                      // two rails, each tilted to match the slope
                const r = box(dir ? 0.08 : sl, 0.12, dir ? sl : 0.08, woodMat, mx, my + ry, mz, g);
                if (dir) r.rotation.x = -Math.atan2(dy, step); else r.rotation.z = Math.atan2(dy, step);
              }
            }
          }
          return g;
        }

        function findFlat() {
          for (let t = 0; t < 240; t++) { const x = (rnd() - 0.5) * WORLD * 0.66, z = (rnd() - 0.5) * WORLD * 0.66; const h = heightAt(x, z); if (h < WATER + 2.5) continue; const hx = heightAt(x + 3, z) - heightAt(x - 3, z), hz = heightAt(x, z + 3) - heightAt(x, z - 3); if (Math.sqrt(hx * hx + hz * hz) < 1.5) return { x, z, h }; }
          return null;
        }
        for (let i = 0; i < 5; i++) { const f = findFlat(); if (!f) continue; makeHouse(f.x, f.z, f.h, rnd() * 6.28); fence(f.x - 8, f.z - 5, 9, 1); fence(f.x - 8, f.z - 5, 9, 0); }

        // low-poly clouds
        const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true, fog: false });
        const cg = new THREE.IcosahedronGeometry(1, 0);
        for (let i = 0; i < 16; i++) {
          const grp = new THREE.Group();
          const blobs = 3 + (rnd() * 4 | 0);
          for (let b = 0; b < blobs; b++) { const m = new THREE.Mesh(cg, cloudMat); const s = 2.6 + rnd() * 3; m.scale.set(s * 1.5, s, s); m.position.set((rnd() - 0.5) * 10, (rnd() - 0.5) * 2.2, (rnd() - 0.5) * 5); grp.add(m); }
          grp.position.set((rnd() - 0.5) * WORLD * 1.1, 58 + rnd() * 48, (rnd() - 0.5) * WORLD * 1.1); scene.add(grp);
          clouds.push({ grp, spd: 1.4 + rnd() * 2.4 });
        }
      })();

      /* ============================================================
         CHARACTER  (visible body, yawed with player) + viewmodel arms
         ============================================================ */
      const skin = new THREE.MeshStandardMaterial({ color: 0xe0a279, roughness: 0.7 });
      const cloth = new THREE.MeshStandardMaterial({ color: 0x3a6ea5, roughness: 0.8 });
      const cloth2 = new THREE.MeshStandardMaterial({ color: 0x2c4a6e, roughness: 0.85 });
      const shoe = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.9 });

      const body = new THREE.Group(); body.visible = false; scene.add(body); // body hidden in first-person; only hands shown
      function limb(w, h, d, mat) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.castShadow = true; return m; }
      const torso = limb(0.85, 1.5, 0.55, cloth); torso.position.y = 2.2; body.add(torso);
      const head = limb(0.62, 0.62, 0.62, skin); head.position.y = 3.25; body.add(head);
      // jointed limbs: hips/shoulders -> knees/elbows, for a realistic gait
      function pivot(x, y, z, parent) { const g = new THREE.Group(); g.position.set(x, y, z); (parent || body).add(g); return g; }
      function makeLeg(side) {
        const hip = pivot(side * 0.24, 1.5, 0);
        const thigh = limb(0.3, 0.72, 0.34, cloth2); thigh.position.y = -0.36; hip.add(thigh);
        const knee = pivot(0, -0.72, 0, hip);
        const shin = limb(0.27, 0.7, 0.3, cloth2); shin.position.y = -0.35; knee.add(shin);
        const foot = limb(0.32, 0.22, 0.52, shoe); foot.position.set(0, -0.72, 0.13); knee.add(foot);
        return { hip, knee };
      }
      function makeArm(side) {
        const sh = pivot(side * 0.55, 3.0, 0);
        const upper = limb(0.24, 0.62, 0.24, cloth); upper.position.y = -0.31; sh.add(upper);
        const elbow = pivot(0, -0.62, 0, sh);
        const fore = limb(0.21, 0.58, 0.21, cloth); fore.position.y = -0.29; elbow.add(fore);
        const hand = limb(0.24, 0.24, 0.24, skin); hand.position.y = -0.62; elbow.add(hand);
        return { sh, elbow };
      }
      const legLj = makeLeg(1), legRj = makeLeg(-1);
      const armLj = makeArm(1), armRj = makeArm(-1);

      /* first-person viewmodel arms (attached to camera) */
      const vm = new THREE.Group(); camera.add(vm);
      function vmArm(side) { const g = new THREE.Group(); const up = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.7, 0.22), cloth); up.position.y = -0.35; g.add(up); const hand = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), skin); hand.position.y = -0.78; g.add(hand); g.position.set(side * 0.42, -0.55, -0.85); g.rotation.x = -0.5; return g; }
      const vmL = vmArm(1), vmR = vmArm(-1); vm.add(vmL, vmR);

      /* a torch/tool held in the right-hand slot (swap geometry for any weapon/tool) */
      const handMat = new THREE.MeshStandardMaterial({ color: 0xe0a279, roughness: 0.7 });
      const torch = new THREE.Group();
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.7, 8), new THREE.MeshStandardMaterial({ color: 0x5a3a1e, roughness: 1 }));
      const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.18, 8), new THREE.MeshStandardMaterial({ color: 0x6b4a24, roughness: 1 })); wrap.position.y = 0.33;
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.42, 8), new THREE.MeshStandardMaterial({ color: 0xffc24a, emissive: 0xff7b1a, emissiveIntensity: 2.4, fog: false }));
      flame.position.y = 0.6;
      const tlight = new THREE.PointLight(0xff9a3c, 1.8, 16); tlight.position.y = 0.65;
      torch.add(handle, wrap, flame, tlight);
      torch.position.set(0, -1.05, 0.05); torch.rotation.x = 0.25;
      vmL.add(torch); torch.visible = false;

      /* ============================================================
         PLAYER MODEL — an animated Mixamo "dwarf" replaces the simple box
         avatar in third-person. If it can't load, the box avatar stays.
         ============================================================ */
      const boxParts = [];
      body.traverse(o => { if (o.isMesh) boxParts.push(o); });
      let usingDwarf = false, playerMixer = null, playerRig = null, playerHeadBone = null;
      const playerActions = {};
      let playerCur = '';
      function setPlayerAction(name, fade = 0.18) {
        if (!playerMixer || !playerActions[name] || playerCur === name) return;
        const next = playerActions[name];
        next.enabled = true; next.reset(); next.play();
        if (playerCur && playerActions[playerCur]) playerActions[playerCur].crossFadeTo(next, fade, false);
        playerCur = name;
      }
      (function loadPlayerModel() {
        if (!THREE.FBXLoader) return;
        const loader = new THREE.FBXLoader();
        const CLIP_FILES = { walk: 'Walking (1).fbx', run: 'Running.fbx', jump: 'Jumping.fbx', punch: 'Hook Punch.fbx', kick: 'Mma Kick.fbx', idle: 'Happy Idle.fbx' };
        loader.load('models/character/Dwarf Idle.fbx', fbx => {
          const bbox = new THREE.Box3().setFromObject(fbx);
          const size = bbox.getSize(new THREE.Vector3());
          const scale = 3.3 / (size.y || 1);            // match the ~3.3-unit tall avatar
          fbx.scale.setScalar(scale);
          fbx.position.y = -bbox.min.y * scale;          // feet at the body-group origin
          fbx.rotation.y = Math.PI;                      // face the player's forward (-Z)
          fbx.traverse(o => {
            if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; o.frustumCulled = false; }
            if (o.isBone && !playerHeadBone && o.name.toLowerCase().indexOf('head') >= 0) playerHeadBone = o;
          });
          body.add(fbx);
          playerRig = fbx;
          playerMixer = new THREE.AnimationMixer(fbx);
          if (fbx.animations && fbx.animations[0]) playerActions.idle = playerMixer.clipAction(stripRootMotion(fbx.animations[0]));
          setPlayerAction('idle', 0);
          boxParts.forEach(m => m.visible = false);      // retire the box avatar
          usingDwarf = true;
          Object.keys(CLIP_FILES).forEach(name => {
            loader.load('models/character/' + CLIP_FILES[name], cf => {
              const clip = cf.animations && cf.animations[0];
              if (clip) { clip.name = name; if (name === 'idle' && playerActions.idle) { playerActions.idle.stop(); } playerActions[name] = playerMixer.clipAction(stripRootMotion(clip)); if (name === 'idle') { playerCur = ''; setPlayerAction('idle', 0.5); } }
            }, undefined, e => console.warn('Could not load clip ' + name, e));
          });
        }, undefined, e => console.warn('Could not load player model', e));
      })();

      /* ============================================================
         CONTROLS  (pointer lock)
         ============================================================ */
      const keys = {};
      let view = 'first';   // 'first' = FPS, 'third' = third-person (toggle with T while exploring)
      let paused = false;   // true while a blocking menu (Main menu / Settings / Inventory) is open -> freeze the world
      let started = false;  // true once the player has entered the world at least once
      let inMainMenu = true;
      let settingsReturnToMenu = false;
      const _PMIDS = ['settingsModal', 'inv', 'aiChat'];

      function setPausedState(val) {
        paused = val;
        if (paused) {
          document.body.classList.add('paused');
        } else {
          document.body.classList.remove('paused');
        }
      }

      function anyOverlayOpen() {
        return _PMIDS.some(id => {
          const e = document.getElementById(id);
          return e && !e.classList.contains('hidden');
        });
      }

      function syncPause() {
        setPausedState(anyOverlayOpen());
        if (paused && document.exitPointerLock) {
          document.exitPointerLock();
        }
      }

      function _hideOverlays() {
        _PMIDS.forEach(id => {
          const e = document.getElementById(id);
          if (e) e.classList.add('hidden');
        });
      }

      function menuOverlayVisible() {
        return overlay && overlay.style.display !== 'none' && !overlay.classList.contains('hide');
      }

      function syncMenuOverlayChrome() {
        const visible = menuOverlayVisible();
        document.body.classList.toggle('menu-overlay-active', visible);
        if (visible) clearInputState();
      }

      function openSettingsPanel() {
        settingsReturnToMenu = inMainMenu || menuOverlayVisible();
        _hideOverlays();
        document.getElementById('settingsModal').classList.remove('hidden');
        if (settingsReturnToMenu) {
          overlay.classList.remove('hide');
          overlay.style.display = 'flex';
        } else {
          overlay.classList.add('hide');
          overlay.style.display = 'none';
        }
        syncPause();
      }

      function openInvPanel() {
        _hideOverlays();
        document.getElementById('inv').classList.remove('hidden');
        overlay.classList.add('hide');
        overlay.style.display = 'none';
        renderInv();
        syncPause();
      }

      function openChatPanel() {
        _hideOverlays();
        document.getElementById('aiChat').classList.remove('hidden');
        overlay.classList.add('hide');
        overlay.style.display = 'none';
        syncPause();
        if (!aiLog.dataset.greeted) {
          aiAppend('a', 'Sage', 'Greetings, wanderer. I am Sage, spirit of Verdant Isle. Ask me for hints, lore, or where the crystals hide.');
          aiLog.dataset.greeted = '1';
        }
        setTimeout(() => aiInput.focus(), 50);
      }

      let closingOverlay = false;
      let pointerLockPending = false;
      let pointerLockRequestId = 0;
      let keepPlayingOnPointerLockFailure = false;
      let suppressNextUnlockPauseMenu = false;
      let suppressBuildUnlockPauseMenu = false;
      let pausedFromBuildMode = false;
      let delayedPointerLockTimer = 0;
      // Give the browser a short gap after ESC before trying to relock from Continue.
      const CONTINUE_RELOCK_DELAY_MS = 1000;
      const MENU_CAMERA_OUT_MS = 720;
      const MENU_CAMERA_IN_MS = Math.max(720, CONTINUE_RELOCK_DELAY_MS + 260);
      const MENU_ORBIT_LOOK_AT = new THREE.Vector3(0, 4, 0);
      const menuCameraTransition = {
        mode: 'idle',
        startedAt: 0,
        duration: 0,
        fromPos: new THREE.Vector3(),
        toPos: new THREE.Vector3(),
        currentPos: new THREE.Vector3(),
        fromQuat: new THREE.Quaternion(),
        toQuat: new THREE.Quaternion(),
        currentQuat: new THREE.Quaternion()
      };

      function hasGamePointerLock() {
        return document.pointerLockElement === canvas;
      }

      function menuCameraTransitionActive() {
        return menuCameraTransition.mode !== 'idle';
      }

      function easeMenuCamera(t) {
        t = Math.max(0, Math.min(1, t));
        return t * t * (3 - 2 * t);
      }

      function captureGameCameraPose(outPos, outQuat) {
        camera.updateMatrixWorld(true);
        camera.getWorldPosition(outPos);
        camera.getWorldQuaternion(outQuat);
      }

      function setOrbitMenuPose(timeSeconds, outPos, outQuat) {
        const orbitRadius = 130;
        const orbitSpeed = 0.045;
        const orbitAngle = timeSeconds * orbitSpeed;
        const camX = Math.sin(orbitAngle) * orbitRadius;
        const camZ = Math.cos(orbitAngle) * orbitRadius;
        const camY = Math.max(32, heightAt(camX, camZ) + 36);
        outPos.set(camX, camY, camZ);
        menuTransitionCam.position.copy(outPos);
        menuTransitionCam.lookAt(MENU_ORBIT_LOOK_AT);
        outQuat.copy(menuTransitionCam.quaternion);
      }

      function setMenuTransitionCamera(pos, quat) {
        menuTransitionCam.position.copy(pos);
        menuTransitionCam.quaternion.copy(quat);
        menuTransitionCam.updateMatrixWorld(true);
      }

      function beginPauseCameraTransition() {
        if (menuCameraTransition.mode === 'toOrbit' || menuCameraTransition.mode === 'orbit') return;
        menuCameraTransition.mode = 'toOrbit';
        menuCameraTransition.startedAt = performance.now();
        menuCameraTransition.duration = MENU_CAMERA_OUT_MS;
        captureGameCameraPose(menuCameraTransition.fromPos, menuCameraTransition.fromQuat);
        setOrbitMenuPose(performance.now() * 0.001, menuCameraTransition.toPos, menuCameraTransition.toQuat);
        setMenuTransitionCamera(menuCameraTransition.fromPos, menuCameraTransition.fromQuat);
      }

      function beginPauseCameraTransitionFromCamera(sourceCamera) {
        if (menuCameraTransition.mode === 'toOrbit' || menuCameraTransition.mode === 'orbit') return;
        menuCameraTransition.mode = 'toOrbit';
        menuCameraTransition.startedAt = performance.now();
        menuCameraTransition.duration = MENU_CAMERA_OUT_MS;
        sourceCamera.updateMatrixWorld(true);
        sourceCamera.getWorldPosition(menuCameraTransition.fromPos);
        sourceCamera.getWorldQuaternion(menuCameraTransition.fromQuat);
        setOrbitMenuPose(performance.now() * 0.001, menuCameraTransition.toPos, menuCameraTransition.toQuat);
        setMenuTransitionCamera(menuCameraTransition.fromPos, menuCameraTransition.fromQuat);
      }

      function beginResumeCameraTransition() {
        menuCameraTransition.mode = 'fromOrbit';
        menuCameraTransition.startedAt = performance.now();
        menuCameraTransition.duration = MENU_CAMERA_IN_MS;
        setOrbitMenuPose(performance.now() * 0.001, menuCameraTransition.fromPos, menuCameraTransition.fromQuat);
        captureGameCameraPose(menuCameraTransition.toPos, menuCameraTransition.toQuat);
        setMenuTransitionCamera(menuCameraTransition.fromPos, menuCameraTransition.fromQuat);
      }

      function beginResumeCameraTransitionFromCamera(sourceCamera) {
        menuCameraTransition.mode = 'fromBuild';
        menuCameraTransition.startedAt = performance.now();
        menuCameraTransition.duration = MENU_CAMERA_IN_MS;
        sourceCamera.updateMatrixWorld(true);
        sourceCamera.getWorldPosition(menuCameraTransition.fromPos);
        sourceCamera.getWorldQuaternion(menuCameraTransition.fromQuat);
        captureGameCameraPose(menuCameraTransition.toPos, menuCameraTransition.toQuat);
        setMenuTransitionCamera(menuCameraTransition.fromPos, menuCameraTransition.fromQuat);
      }

      function beginResumeCameraTransitionToCamera(targetCamera) {
        menuCameraTransition.mode = 'fromOrbitToBuild';
        menuCameraTransition.startedAt = performance.now();
        menuCameraTransition.duration = MENU_CAMERA_OUT_MS;
        setOrbitMenuPose(performance.now() * 0.001, menuCameraTransition.fromPos, menuCameraTransition.fromQuat);
        targetCamera.updateMatrixWorld(true);
        targetCamera.getWorldPosition(menuCameraTransition.toPos);
        targetCamera.getWorldQuaternion(menuCameraTransition.toQuat);
        setMenuTransitionCamera(menuCameraTransition.fromPos, menuCameraTransition.fromQuat);
      }

      function cancelMenuCameraTransition() {
        menuCameraTransition.mode = 'idle';
      }

      function updateMenuCameraTransition() {
        const modeNow = menuCameraTransition.mode;
        if (modeNow === 'idle') return null;
        if (modeNow === 'orbit') {
          setOrbitMenuPose(performance.now() * 0.001, menuCameraTransition.currentPos, menuCameraTransition.currentQuat);
          setMenuTransitionCamera(menuCameraTransition.currentPos, menuCameraTransition.currentQuat);
          return menuTransitionCam;
        }

        const elapsed = performance.now() - menuCameraTransition.startedAt;
        const t = easeMenuCamera(elapsed / menuCameraTransition.duration);
        menuCameraTransition.currentPos.lerpVectors(menuCameraTransition.fromPos, menuCameraTransition.toPos, t);
        menuCameraTransition.currentQuat.slerpQuaternions(menuCameraTransition.fromQuat, menuCameraTransition.toQuat, t);
        setMenuTransitionCamera(menuCameraTransition.currentPos, menuCameraTransition.currentQuat);

        if (t >= 1) {
          menuCameraTransition.mode = modeNow === 'toOrbit' ? 'orbit' : 'idle';
        }
        return menuTransitionCam;
      }

      function clearDelayedPointerLockTimer() {
        if (delayedPointerLockTimer) {
          clearTimeout(delayedPointerLockTimer);
          delayedPointerLockTimer = 0;
        }
      }

      function clearInputState() {
        for (const code in keys) keys[code] = false;
      }

      function showPauseMenu() {
        clearInputState();
        pausedFromBuildMode = false;
        if (!inMainMenu) {
          beginPauseCameraTransition();
          document.getElementById('startupButtons').classList.add('hidden-group');
          document.getElementById('pausedButtons').classList.remove('hidden-group');
        }
        overlay.classList.remove('hide');
        overlay.style.display = 'flex';
        syncMenuOverlayChrome();
        setPausedState(true);
      }

      function hideMenuOverlay() {
        overlay.classList.add('hide');
        syncMenuOverlayChrome();
        overlay.addEventListener('transitionend', function handler() {
          if (overlay.classList.contains('hide')) overlay.style.display = 'none';
          syncMenuOverlayChrome();
          overlay.removeEventListener('transitionend', handler);
        });
      }

      function hideMenuOverlayNow() {
        overlay.classList.add('hide');
        overlay.style.display = 'none';
        syncMenuOverlayChrome();
      }

      function handlePointerLockFailure() {
        if (hasGamePointerLock()) return;
        pointerLockPending = false;
        if (!paused) {
          keepPlayingOnPointerLockFailure = false;
          suppressNextUnlockPauseMenu = false;
          _hideOverlays();
          hideMenuOverlayNow();
          return;
        }
        if (keepPlayingOnPointerLockFailure) {
          keepPlayingOnPointerLockFailure = false;
          _hideOverlays();
          hideMenuOverlay();
          setPausedState(false);
          return;
        }
        _hideOverlays();
        if (!inMainMenu) showPauseMenu();
      }

      function tryRequestPointerLock(requestId) {
        if (!pointerLockPending || pointerLockRequestId !== requestId || hasGamePointerLock()) return;

        let result;
        try {
          if (typeof canvas.focus === 'function') {
            if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = -1;
            canvas.focus({ preventScroll: true });
          }
          result = canvas.requestPointerLock();
        } catch (err) {
          handlePointerLockFailure();
          return;
        }

        if (result && typeof result.catch === 'function') {
          result.catch(handlePointerLockFailure);
        } else {
          setTimeout(() => {
            if (pointerLockPending && pointerLockRequestId === requestId && !hasGamePointerLock()) {
              handlePointerLockFailure();
            }
          }, 1200);
        }
      }

      function requestGamePointerLock(options = {}) {
        const showMenuWhilePending = options.showMenuWhilePending ?? menuOverlayVisible();
        if (pointerLockPending) return;
        if (hasGamePointerLock()) {
          _hideOverlays();
          hideMenuOverlay();
          keepPlayingOnPointerLockFailure = false;
          suppressNextUnlockPauseMenu = false;
          suppressBuildUnlockPauseMenu = false;
          setPausedState(false);
          return;
        }
        if (!canvas.requestPointerLock) {
          showPauseMenu();
          return;
        }

        pointerLockPending = true;
        const requestId = ++pointerLockRequestId;
        keepPlayingOnPointerLockFailure = !!options.keepPlayingOnFailure;
        suppressNextUnlockPauseMenu = !!options.keepPlayingOnFailure;
        _hideOverlays();
        setPausedState(!options.resumeImmediately);
        if (showMenuWhilePending) {
          overlay.classList.remove('hide');
          overlay.style.display = 'flex';
        } else {
          overlay.classList.add('hide');
          overlay.style.display = 'none';
        }

        tryRequestPointerLock(requestId);
      }

      function scheduleGamePointerLock(delayMs) {
        clearDelayedPointerLockTimer();
        delayedPointerLockTimer = setTimeout(() => {
          delayedPointerLockTimer = 0;
          if (inMainMenu || paused || anyOverlayOpen() || hasGamePointerLock()) return;
          requestGamePointerLock({ showMenuWhilePending: false, resumeImmediately: true, keepPlayingOnFailure: true });
        }, delayMs);
      }

      function resumeGame(options = {}) {
        if (inMainMenu) {
          _hideOverlays();
          overlay.classList.remove('hide');
          overlay.style.display = 'flex';
          setPausedState(true);
        } else if (mode === 'god') {
          _hideOverlays();
          hideMenuOverlayNow();
          setPausedState(false);
        } else {
          // Default panels stay paused until pointerlockchange confirms lock.
          // Continue can pass options to resume immediately and hide the pause menu.
          requestGamePointerLock(options);
        }
      }

      function continueFromPauseMenu() {
        pointerLockPending = false;
        keepPlayingOnPointerLockFailure = false;
        suppressNextUnlockPauseMenu = false;
        suppressBuildUnlockPauseMenu = false;
        _hideOverlays();
        hideMenuOverlayNow();
        if (pausedFromBuildMode) {
          pausedFromBuildMode = false;
          clearInputState();
          setPausedState(false);
          setMode('god', { preserveGodTarget: true });
          beginResumeCameraTransitionToCamera(godCam);
          return;
        }
        beginResumeCameraTransition();
        setPausedState(false);
        scheduleGamePointerLock(CONTINUE_RELOCK_DELAY_MS);
      }

      function closeSettingsPanel() {
        document.getElementById('settingsModal').classList.add('hidden');
        if (settingsReturnToMenu) {
          settingsReturnToMenu = false;
          overlay.classList.remove('hide');
          overlay.style.display = 'flex';
          setPausedState(true);
        } else {
          resumeGame();
        }
      }

      const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'); };

      addEventListener('keydown', e => {
        if (typing()) return;
        if (menuOverlayVisible()) { clearInputState(); return; }
        keys[e.code] = true;
        if (!inMainMenu) {
          if (e.code === 'KeyT' && mode === 'fps') view = (view === 'first' ? 'third' : 'first');
          if (e.code === 'KeyE' && mode === 'fps') tryOpenChest();
          if (e.code === 'KeyI') toggleInv();
          if (e.code === 'KeyC') toggleChat();
          if (e.code === 'KeyO') toggleSettings();
          if (e.code === 'KeyF' && mode === 'fps') toggleParrotMode();
        }
      });

      function toggleInv() {
        if (menuOverlayVisible()) return;
        const p = document.getElementById('inv');
        if (p.classList.contains('hidden')) {
          openInvPanel();
        } else {
          resumeGame();
        }
      }

      function toggleSettings() {
        if (menuOverlayVisible()) return;
        const p = document.getElementById('settingsModal');
        if (p.classList.contains('hidden')) {
          openSettingsPanel();
        } else {
          closeSettingsPanel();
        }
      }

      function toggleChat() {
        if (menuOverlayVisible()) return;
        const p = document.getElementById('aiChat');
        if (p.classList.contains('hidden')) {
          openChatPanel();
        } else {
          resumeGame();
        }
      }

      window.addEventListener('load', () => {
        const ib = document.getElementById('invBtn'), ip = document.getElementById('inv'), ic = document.getElementById('invClose');
        if (ib) ib.addEventListener('click', toggleInv);
        if (ic) ic.addEventListener('click', resumeGame);
        if (ip) ip.addEventListener('click', e => { if (e.target === ip) { resumeGame(); } });
      });
      addEventListener('keyup', e => {
        keys[e.code] = false;
        if (e.code === 'Escape') {
          if (anyOverlayOpen()) {
            // A panel (Settings/Inventory/Chat) is open — close it in its original context.
            e.preventDefault();
            if (document.getElementById('settingsModal').classList.contains('hidden')) {
              resumeGame();
            } else {
              closeSettingsPanel();
            }
          } else if (mode === 'god' && !inMainMenu) {
            e.preventDefault();
            pauseFromBuildMode();
          }
          // Keep relock tied to the next Continue click; ESC is the browser's unlock gesture.
        }
      });

      /* ---- AI "island spirit" chat (NVIDIA NIM, OpenAI-compatible via CORS proxy) ---- */
      const AI_KEY = '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';
      const AI_MODEL = 'meta/llama-3.1-8b-instruct';
      const AI_URL = 'https://proxy.corsfix.com/?https://integrate.api.nvidia.com/v1/chat/completions';
      const aiChat = document.getElementById('aiChat'), aiLog = document.getElementById('aiLog'), aiInput = document.getElementById('aiInput');
      const aiHistory = []; let aiBusy = false;
      function aiSysMsg() {
        return { role: 'system', content: 'You are Sage, the warm, wise and slightly playful spirit of Verdant Isle — a low-poly 3D island in a browser game. Stay in character and keep replies short (1-3 small paragraphs). The player explores in first or third person (press T to switch), collects glowing crystals, plants trees, builds with build mode (press G), and fights slime monsters by clicking. Live state -> crystals: ' + score + '/' + crystals.length + ', slimes defeated: ' + kills + ', health: ' + Math.round(playerHP) + ', biome: ' + currentBiome + '. Offer hints, lore and encouragement. You may also answer off-topic questions helpfully, still in character.' };
      }
      /* ---- TTS (Puter.js Neural TTS) ---- */
      let aiAutoTts = false;
      let currentAudio = null;
      let currentBtn = null;
      function speakText(text, btn) {
        if (!window.puter) {
          console.warn("Puter.js is not loaded.");
          return;
        }
        if (currentAudio) {
          currentAudio.pause();
          currentAudio = null;
          if (currentBtn) currentBtn.classList.remove('speaking');
          if (currentBtn === btn) {
            currentBtn = null;
            return;
          }
        }
        if (btn) {
          btn.classList.add('speaking');
          currentBtn = btn;
        }
        puter.ai.txt2speech(text, { provider: "openai", model: "tts-1", voice: "nova" })
          .then((audio) => {
            currentAudio = audio;
            audio.addEventListener('ended', () => {
              if (btn) btn.classList.remove('speaking');
              if (currentBtn === btn) currentBtn = null;
              currentAudio = null;
            });
            audio.addEventListener('pause', () => {
              if (btn) btn.classList.remove('speaking');
            });
            audio.play().catch(e => {
              console.error("Audio play error", e);
              if (btn) btn.classList.remove('speaking');
            });
          })
          .catch((err) => {
            console.error("Puter TTS Error:", err);
            if (btn) btn.classList.remove('speaking');
            if (currentBtn === btn) currentBtn = null;
          });
      }
      function aiAppend(cls, who, text) {
        const d = document.createElement('div'); d.className = cls;
        if (/[\u0590-\u05FF]/.test(text)) {
          d.classList.add('hebrew-rtl');
        }
        const w = document.createElement('span'); w.className = 'who'; w.textContent = who + ': ';
        const s = document.createElement('span'); s.textContent = text;
        d.appendChild(w); d.appendChild(s);
        if (cls === 'a') {
          const btn = document.createElement('button'); btn.className = 'ai-tts'; btn.textContent = '🔊'; btn.title = 'Read aloud';
          btn.addEventListener('click', () => speakText(s.textContent, btn));
          d.appendChild(btn); d._ttsBtn = btn;
        }
        aiLog.appendChild(d); aiLog.scrollTop = aiLog.scrollHeight; return s;
      }
      async function aiSend() {
        const q = aiInput.value.trim(); if (!q || aiBusy) return; aiInput.value = '';
        aiAppend('u', 'You', q); aiHistory.push({ role: 'user', content: q });
        const span = aiAppend('a', 'Sage', '…'); span.textContent = ''; aiBusy = true;

        const select = document.getElementById('sAiModel');
        const modelVal = select ? select.value : 'llama';

        let modelId = 'meta/llama-3.1-8b-instruct';
        let apiKey = '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';
        let maxTokens = 512;
        let requestBody = {
          messages: [aiSysMsg(), ...aiHistory],
          temperature: 1.0,
          top_p: 0.95,
          stream: false
        };

        if (modelVal === 'minimax') {
          modelId = 'minimaxai/minimax-m3';
          apiKey = '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';
          maxTokens = 4096;
        } else if (modelVal === 'diffusiongemma') {
          modelId = 'google/diffusiongemma-26b-a4b-it';
          apiKey = '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';
          maxTokens = 4096;
          requestBody.chat_template_kwargs = { "enable_thinking": true };
        }

        requestBody.model = modelId;
        requestBody.max_tokens = maxTokens;

        try {
          const res = await fetch(AI_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + apiKey
            },
            body: JSON.stringify(requestBody)
          });
          if (!res.ok) { span.textContent = '(Sage is silent — API error ' + res.status + ')'; return; }
          const j = await res.json();
          const acc = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (acc) {
            span.textContent = acc;
            if (/[\u0590-\u05FF]/.test(acc)) {
              span.parentElement.classList.add('hebrew-rtl');
            }
            aiLog.scrollTop = aiLog.scrollHeight;
            aiHistory.push({ role: 'assistant', content: acc });
            if (aiAutoTts) { const ttsBtn = span.parentElement._ttsBtn; speakText(acc, ttsBtn); }
          } else {
            span.textContent = '(Sage is silent — unexpected API response)';
          }
        } catch (err) { span.textContent = '(Could not reach Sage. The NVIDIA endpoint may block direct browser calls (CORS) — a small local proxy would be needed.)'; }
        finally { aiBusy = false; }
      }
      document.getElementById('aiBtn').addEventListener('click', toggleChat);
      document.getElementById('aiClose').addEventListener('click', () => {
        resumeGame();
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        if (currentBtn) { currentBtn.classList.remove('speaking'); currentBtn = null; }
      });
      document.getElementById('aiAutoTts').addEventListener('click', () => {
        aiAutoTts = !aiAutoTts;
        const b = document.getElementById('aiAutoTts');
        b.textContent = aiAutoTts ? '🔊' : '🔇';
        b.classList.toggle('on', aiAutoTts);
        if (!aiAutoTts && currentAudio) {
          currentAudio.pause();
          currentAudio = null;
          if (currentBtn) { currentBtn.classList.remove('speaking'); currentBtn = null; }
        }
      });
      document.getElementById('aiSend').addEventListener('click', aiSend);
      aiInput.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); aiSend(); } });

      // Prevent clicks/drags in the chat from leaking to the canvas/gameplay
      aiChat.addEventListener('mousedown', e => { e.stopPropagation(); });
      aiChat.addEventListener('click', e => { e.stopPropagation(); });

      // Chat window dragging logic
      const aiHead = document.getElementById('aiHead');
      let isDragging = false;
      let startX, startY, initialLeft, initialTop;

      aiHead.addEventListener('mousedown', e => {
        if (e.target.closest('button')) return;
        isDragging = true;
        if (document.exitPointerLock) document.exitPointerLock();

        const rect = aiChat.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        startX = e.clientX;
        startY = e.clientY;

        aiChat.style.bottom = 'auto';
        aiChat.style.left = initialLeft + 'px';
        aiChat.style.top = initialTop + 'px';

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
      });

      function onMouseMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        newLeft = Math.max(0, Math.min(window.innerWidth - aiChat.offsetWidth, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - aiChat.offsetHeight, newTop));

        aiChat.style.left = newLeft + 'px';
        aiChat.style.top = newTop + 'px';
      }

      function onMouseUp() {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
      let pitch = 0, yaw = 0, locked = false;
      document.addEventListener('mousemove', e => { if (!locked || menuCameraTransitionActive()) return; yaw -= e.movementX * 0.0022; pitch -= e.movementY * 0.0022; pitch = Math.max(-1.3, Math.min(1.3, pitch)); });
      const overlay = document.getElementById('overlay');
      new MutationObserver(syncMenuOverlayChrome).observe(overlay, { attributes: true, attributeFilter: ['class', 'style'] });
      syncMenuOverlayChrome();
      /* ---- procedural audio: ambient music + ocean wave ambience + SFX (Web Audio, no files) ---- */
      let _actx = null, _master = null, _mGain = null, _ambGain = null, _sfxGain = null, _mTimer = null, musicOn = true, _musicStarted = false, _volume = 0.9, currentBiome = 'Meadow';
      function startMusic() {
        if (_musicStarted) { if (_actx && _actx.state === 'suspended') _actx.resume(); return; }
        try {
          _actx = new (window.AudioContext || window.webkitAudioContext)();
          _master = _actx.createGain(); _master.gain.value = _volume; _master.connect(_actx.destination);
          _mGain = _actx.createGain(); _mGain.gain.value = 0; _mGain.connect(_master);
          _mGain.gain.linearRampToValueAtTime(musicOn ? 0.16 : 0, _actx.currentTime + 4);
          _ambGain = _actx.createGain(); _ambGain.gain.value = 0; _ambGain.connect(_master);
          _ambGain.gain.linearRampToValueAtTime(0.5, _actx.currentTime + 5);
          _sfxGain = _actx.createGain(); _sfxGain.gain.value = 0.34; _sfxGain.connect(_master);

          // --- ocean wave ambience: looped filtered noise washed by a slow LFO ---
          const bufLen = _actx.sampleRate * 3, buf = _actx.createBuffer(1, bufLen, _actx.sampleRate), nd = buf.getChannelData(0);
          for (let i = 0; i < bufLen; i++) nd[i] = Math.random() * 2 - 1;
          const nsrc = _actx.createBufferSource(); nsrc.buffer = buf; nsrc.loop = true;
          const bp = _actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 540; bp.Q.value = 0.55;
          const lp = _actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 950;
          const wGain = _actx.createGain(); wGain.gain.value = 0.12;
          nsrc.connect(bp); bp.connect(lp); lp.connect(wGain); wGain.connect(_ambGain);
          const lfo = _actx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.13;
          const lfoG = _actx.createGain(); lfoG.gain.value = 0.085; lfo.connect(lfoG); lfoG.connect(wGain.gain);
          nsrc.start(); lfo.start();

          // --- musical pads + sparkle (chord palette shifts by biome) ---
          const chordSets = {
            Meadow: [[146.83, 220, 277.18, 329.63], [130.81, 196, 246.94, 329.63], [174.61, 220, 261.63, 349.23]],
            Shore: [[174.61, 261.63, 349.23, 440.0], [196.0, 293.66, 392.0, 493.88], [220.0, 329.63, 440.0, 554.37]],
            Highlands: [[110.0, 164.81, 220.0, 261.63], [98.0, 146.83, 196.0, 246.94], [123.47, 185.0, 246.94, 311.13]]
          };
          let ci = 0;
          function pad() {
            if (!_actx) return;
            const set = chordSets[currentBiome] || chordSets.Meadow;
            const t0 = _actx.currentTime, dur = 8, notes = set[ci % set.length]; ci++;
            notes.forEach((f, k) => {
              const o = _actx.createOscillator(); o.type = k === 0 ? 'triangle' : 'sine'; o.frequency.value = f;
              const det = _actx.createOscillator(); det.type = 'sine'; det.frequency.value = f * 1.006;
              const g = _actx.createGain(); g.gain.value = 0;
              const lpf = _actx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 1100;
              o.connect(lpf); det.connect(lpf); lpf.connect(g); g.connect(_mGain);
              const peak = k === 0 ? 0.13 : 0.075;
              g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(peak, t0 + 2.6); g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
              o.start(t0); det.start(t0); o.stop(t0 + dur + 0.2); det.stop(t0 + dur + 0.2);
            });
            const sf = [523.25, 587.33, 659.25, 783.99, 880.0][(Math.random() * 5) | 0];
            const so = _actx.createOscillator(); so.type = 'sine'; so.frequency.value = sf;
            const sg = _actx.createGain(); sg.gain.value = 0; so.connect(sg); sg.connect(_mGain);
            const stt = t0 + 2 + Math.random() * 3.5;
            sg.gain.setValueAtTime(0, stt); sg.gain.linearRampToValueAtTime(0.045, stt + 0.05); sg.gain.exponentialRampToValueAtTime(0.0001, stt + 2.6);
            so.start(stt); so.stop(stt + 2.7);
          }
          pad(); _mTimer = setInterval(pad, 7000);
          _musicStarted = true;
        } catch (e) {
          if (_mTimer) { clearInterval(_mTimer); _mTimer = null; }
          _actx = _master = _mGain = _ambGain = _sfxGain = null;
          _musicStarted = false;
          console.warn('Audio startup failed; will retry on the next interaction.', e);
        }
      }
      function setMusic(on) {
        musicOn = on;
        if (_mGain && _actx) { _mGain.gain.cancelScheduledValues(_actx.currentTime); _mGain.gain.linearRampToValueAtTime(on ? 0.16 : 0, _actx.currentTime + 0.6); }
        const b = document.getElementById('sMusic'); if (b) b.innerHTML = on ? '<span class="ui-ic">🔊</span> Music: On' : '<span class="ui-ic">🔇</span> Music: Off';
      }
      /* ---- one-shot sound effects ---- */
      function sfxCollect() {
        if (!_actx) return; const t0 = _actx.currentTime;
        [659.25, 987.77, 1318.51].forEach((f, k) => {
          const o = _actx.createOscillator(); o.type = 'sine'; o.frequency.value = f; const g = _actx.createGain(); o.connect(g); g.connect(_sfxGain); const ts = t0 + k * 0.07;
          g.gain.setValueAtTime(0, ts); g.gain.linearRampToValueAtTime(0.22, ts + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, ts + 0.4); o.start(ts); o.stop(ts + 0.45);
        });
      }
      function sfxJump() {
        if (!_actx) return; const t0 = _actx.currentTime; const o = _actx.createOscillator(); o.type = 'triangle';
        o.frequency.setValueAtTime(300, t0); o.frequency.exponentialRampToValueAtTime(640, t0 + 0.16);
        const g = _actx.createGain(); o.connect(g); g.connect(_sfxGain);
        g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.2, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22); o.start(t0); o.stop(t0 + 0.25);
      }
      function sfxStep() {
        if (!_actx) return; const t0 = _actx.currentTime; const o = _actx.createOscillator(); o.type = 'sine'; o.frequency.value = 86 + Math.random() * 34;
        const g = _actx.createGain(); o.connect(g); g.connect(_sfxGain);
        g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.1, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12); o.start(t0); o.stop(t0 + 0.14);
      }
      function sfxSplash() {
        if (!_actx) return; const t0 = _actx.currentTime, len = (_actx.sampleRate * 0.4) | 0, b = _actx.createBuffer(1, len, _actx.sampleRate), d = b.getChannelData(0);
        for (let i = 0; i < len; i++)d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const s = _actx.createBufferSource(); s.buffer = b; const bp = _actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(1400, t0); bp.frequency.exponentialRampToValueAtTime(500, t0 + 0.35); bp.Q.value = 0.8;
        const g = _actx.createGain(); g.gain.value = 0.32; s.connect(bp); bp.connect(g); g.connect(_sfxGain); s.start(t0);
      }
      function setVolume(v) { _volume = v; if (_master) _master.gain.setTargetAtTime(v, _actx.currentTime, 0.05); }
      addEventListener('keydown', e => { if (!menuOverlayVisible() && e.code === 'KeyM') setMusic(!musicOn); });

      document.getElementById('play').addEventListener('click', () => {
        startMusic();
        if (inMainMenu) {
          inMainMenu = false;
          pitch = 0;
          yaw = 0;
          player.rotation.set(0, 0, 0);
          camera.rotation.set(0, 0, 0);
          // show HUD
          document.getElementById('hud').style.display = 'block';
          // show enemies
          enemies.forEach(e => e.visible = true);
        }
        requestGamePointerLock();
      });

      // Multiplayer (locked)
      document.getElementById('btnMultiplayer').addEventListener('click', (e) => {
        e.stopPropagation();
        toast('🔒 Multiplayer mode is coming soon!');
      });

      // Settings
      document.getElementById('btnSettings').addEventListener('click', (e) => {
        e.stopPropagation();
        openSettingsPanel();
      });

      // Help and controls modal toggling
      const helpModal = document.getElementById('helpModal');
      document.getElementById('btnHelp').addEventListener('click', (e) => {
        e.stopPropagation();
        helpModal.classList.remove('hidden-modal');
      });
      document.getElementById('helpCloseBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        helpModal.classList.add('hidden-modal');
      });

      // Exit game
      document.getElementById('btnExit').addEventListener('click', (e) => {
        e.stopPropagation();
        toast('🚪 To exit, please close this browser tab.');
        setTimeout(() => {
          try { window.close(); } catch (err) { }
        }, 1000);
      });
      document.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target.closest('#btnContinue') : null;
        if (!target) return;
        e.preventDefault();
        continueFromPauseMenu();
      }, true);

      // End Current Game
      document.getElementById('btnEndGame').addEventListener('click', (e) => {
        e.stopPropagation();
        clearDelayedPointerLockTimer();
        cancelMenuCameraTransition();
        pointerLockPending = false;
        keepPlayingOnPointerLockFailure = false;
        suppressNextUnlockPauseMenu = false;
        suppressBuildUnlockPauseMenu = false;
        pausedFromBuildMode = false;
        inMainMenu = true;
        paused = false;
        if (mode === 'god') setMode('fps');
        pitch = 0;
        yaw = 0;
        player.rotation.set(0, 0, 0);
        camera.rotation.set(0, 0, 0);

        // Reset stats
        score = 0;
        kills = 0;
        gold = 0;
        keysHeld = 0;
        playerHP = 100;

        document.getElementById('got').textContent = '0';
        const s = document.getElementById('score');
        s.innerHTML = 'Crystals<br><span class="big"><span id="got">0</span>/<span id="total">' + crystals.length + '</span></span>';
        updateTreasureHUD();
        document.getElementById('hpNum').textContent = '100';
        document.getElementById('kills').textContent = '0';

        // Reset player spawn position
        player.position.set(0, heightAt(0, 0) + EYE, 30);
        vel.set(0, 0, 0);
        vy = 0;
        air = 1;

        // Reset inventory
        for (const k in inventory) delete inventory[k];
        equippedWeapon = null;
        playerDmg = 1;
        const eqW = document.getElementById('eqW');
        if (eqW) eqW.textContent = 'Fists';

        // Reset crystals
        crystals.forEach(c => {
          c.got = false;
          c.mesh.visible = true;
        });

        // Reset keys
        keysArr.forEach(k => {
          k.got = false;
          k.mesh.visible = true;
        });

        // Reset chests
        chests.forEach(c => {
          c.opened = false;
          c.openAmt = 0;
          c.lid.rotation.x = 0;
        });

        // Hide HUD and slimes
        document.getElementById('hud').style.display = 'none';
        enemies.forEach(e => e.visible = false);

        // Reset button views
        document.getElementById('startupButtons').classList.remove('hidden-group');
        document.getElementById('pausedButtons').classList.add('hidden-group');

        // Reset overlays
        _hideOverlays();
        overlay.classList.remove('hide');
        overlay.style.display = 'flex';
      });

      // click the scene to (re)grab the mouse
      canvas.addEventListener('click', () => { if (paused || inMainMenu || menuCameraTransitionActive()) return; startMusic(); if (mode === 'god') { placeAtCursor(); return; } if (!locked) { if (!delayedPointerLockTimer) requestGamePointerLock({ showMenuWhilePending: false, resumeImmediately: true, keepPlayingOnFailure: true }); } else { attack(); } });

      document.addEventListener('pointerlockchange', () => {
        const wasLocked = locked;
        locked = hasGamePointerLock();
        pointerLockPending = false;
        if (locked) {
          clearDelayedPointerLockTimer();
          keepPlayingOnPointerLockFailure = false;
          suppressNextUnlockPauseMenu = false;
          suppressBuildUnlockPauseMenu = false;
          _hideOverlays();
          hideMenuOverlay();
          if (!inMainMenu) {
            setPausedState(false);
          }
        } else {
          if (!inMainMenu) {
            if (suppressBuildUnlockPauseMenu) {
              suppressBuildUnlockPauseMenu = false;
              keepPlayingOnPointerLockFailure = false;
              suppressNextUnlockPauseMenu = false;
              _hideOverlays();
              hideMenuOverlayNow();
              setPausedState(false);
              clearInputState();
              return;
            }
            if (suppressNextUnlockPauseMenu && !wasLocked) {
              suppressNextUnlockPauseMenu = false;
              _hideOverlays();
              hideMenuOverlayNow();
              setPausedState(false);
              return;
            }
            keepPlayingOnPointerLockFailure = false;
            suppressNextUnlockPauseMenu = false;
            if (!wasLocked) {
              return;
            }
            if (!anyOverlayOpen() && !closingOverlay) {
              showPauseMenu();
            } else {
              clearInputState();
              setPausedState(true);
            }
          }
        }
      });

      document.addEventListener('pointerlockerror', handlePointerLockFailure);

      /* ============================================================
         GOD / BUILDER MODE  (top-down strategy camera + placeable props)
         ============================================================ */
      let mode = 'fps', tool = 'tree', lastHit = null;
      const godCam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 2000);
      const godTarget = new THREE.Vector3(0, 0, 30);
      let godYaw = 0.6, godPitch = 0.92, godDist = 95;
      const _ndc = new THREE.Vector2(0, 0), _ray = new THREE.Raycaster();

      // terrain-conforming ring cursor (band of segments whose Y follows the ground)
      const CUR_N = 56, CUR_RI = 1.5, CUR_RO = 2.15, cursorAng = [];
      const cursorGeo = new THREE.BufferGeometry();
      (function () { const verts = new Float32Array((CUR_N + 1) * 2 * 3), idx = []; for (let i = 0; i <= CUR_N; i++)cursorAng.push(i / CUR_N * Math.PI * 2); for (let i = 0; i < CUR_N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } cursorGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3)); cursorGeo.setIndex(idx); })();
      const cursor = new THREE.Mesh(cursorGeo, new THREE.MeshBasicMaterial({ color: 0x6cf0ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
      cursor.frustumCulled = false; cursor.visible = false; cursor.renderOrder = 3; scene.add(cursor);
      function updateCursorRing(cx, cz) {
        const pa = cursorGeo.attributes.position;
        for (let i = 0; i <= CUR_N; i++) {
          const ix = Math.cos(cursorAng[i]), iz = Math.sin(cursorAng[i]);
          const xi = cx + ix * CUR_RI, zi = cz + iz * CUR_RI, xo = cx + ix * CUR_RO, zo = cz + iz * CUR_RO;
          pa.setXYZ(i * 2, xi, heightAt(xi, zi) + 0.25, zi);
          pa.setXYZ(i * 2 + 1, xo, heightAt(xo, zo) + 0.25, zo);
        }
        pa.needsUpdate = true; cursorGeo.computeBoundingSphere();
      }

      const placed = [];
      const bM = {
        trunk: new THREE.MeshStandardMaterial({ color: 0x7c5230, roughness: 1, flatShading: true }),
        leaf: new THREE.MeshStandardMaterial({ color: 0x4f9433, roughness: 0.9, flatShading: true }),
        rock: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 1, flatShading: true }),
        bush: new THREE.MeshStandardMaterial({ color: 0x55993a, roughness: 0.95, flatShading: true }),
        crystal: new THREE.MeshStandardMaterial({ color: 0x4fd6ee, emissive: 0x39c8e0, emissiveIntensity: 0.9, roughness: 0.25 }),
        pine: new THREE.MeshStandardMaterial({ color: 0x2f7d6b, roughness: 0.9, flatShading: true }),
        birch: new THREE.MeshStandardMaterial({ color: 0xece8de, roughness: 0.85, flatShading: true }),
        birchMark: new THREE.MeshStandardMaterial({ color: 0x3a3a38, roughness: 1, flatShading: true }),
        leaf2: new THREE.MeshStandardMaterial({ color: 0x9ed35a, roughness: 0.9, flatShading: true }),
        fruit: new THREE.MeshStandardMaterial({ color: 0xe23b2e, roughness: 0.6, flatShading: true }),
        bark: new THREE.MeshStandardMaterial({ color: 0x8a5a2c, roughness: 1, flatShading: true }),
        barkDark: new THREE.MeshStandardMaterial({ color: 0x5e3c1c, roughness: 1, flatShading: true }),
        canopyA: new THREE.MeshStandardMaterial({ color: 0x3f9233, vertexColors: true, roughness: 0.92, flatShading: true }),
        canopyB: new THREE.MeshStandardMaterial({ color: 0x77c247, vertexColors: true, roughness: 0.92, flatShading: true }),
        berry: new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.6, flatShading: true }),
        wall: new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.95, flatShading: true }),
        roof: new THREE.MeshStandardMaterial({ color: 0xd6452f, roughness: 0.9, flatShading: true }),
        stone: new THREE.MeshStandardMaterial({ color: 0xb9bdc2, roughness: 1, flatShading: true })
      };
      Object.keys(bM).forEach(k => useFrontShadowFaces(bM[k]));
      const bG = {
        trunk: (() => { const g = new THREE.CylinderGeometry(0.34, 0.5, 4.6, 7); g.translate(0, 2.3, 0); return g; })(),
        ball: new THREE.IcosahedronGeometry(2.6, 1), rock: new THREE.DodecahedronGeometry(1, 0), rock2: new THREE.IcosahedronGeometry(1, 0),
        crystal: new THREE.OctahedronGeometry(0.6, 0), canopy: new THREE.IcosahedronGeometry(1, 1), berry: new THREE.IcosahedronGeometry(0.12, 0)
      };
      // bake dark-underside -> bright-crown gradient onto the canopy blob (the reference look)
      (function () { const p = bG.canopy.attributes.position, cs = []; let mn = 1e9, mx = -1e9; for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < mn) mn = y; if (y > mx) mx = y; } for (let i = 0; i < p.count; i++) { const tt = (p.getY(i) - mn) / (mx - mn); const s = 0.5 + 0.65 * tt; cs.push(s, s, s); } bG.canopy.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3)); })();
      // branch that RETURNS its tip position so foliage can sit exactly on the end of the branch
      const _eul = new THREE.Euler();
      function branch(g, px, py, pz, len, r0, r1, rz, rx, mat) {
        const ge = new THREE.CylinderGeometry(r1, r0, len, 5); ge.translate(0, len / 2, 0);
        const m = new THREE.Mesh(ge, mat || bM.bark); m.position.set(px, py, pz); m.rotation.set(rx || 0, 0, rz || 0);
        m.castShadow = true; m.receiveShadow = true; g.add(m);
        _eul.set(rx || 0, 0, rz || 0); const dir = new THREE.Vector3(0, 1, 0).applyEuler(_eul);
        return { x: px + dir.x * len, y: py + dir.y * len, z: pz + dir.z * len };
      }
      function branchTip(px, py, pz, len, rz, rx) {
        _eul.set(rx || 0, 0, rz || 0);
        const dir = new THREE.Vector3(0, 1, 0).applyEuler(_eul);
        return { x: px + dir.x * len, y: py + dir.y * len, z: pz + dir.z * len };
      }
      function addTrunkSegment(list, px, py, pz, len, r0, r1, rz, rx) {
        list.push({ x: px, y: py, z: pz, len, r0, r1, rz: rz || 0, rx: rx || 0 });
        return branchTip(px, py, pz, len, rz, rx);
      }
      function mergeBufferGeometries(geos) {
        const pos = [], nor = [], idx = [];
        let offset = 0;
        for (let g = 0; g < geos.length; g++) {
          const geo = geos[g];
          const p = geo.attributes.position.array;
          const n = geo.attributes.normal ? geo.attributes.normal.array : null;
          for (let i = 0; i < p.length; i++) pos.push(p[i]);
          if (n) for (let i = 0; i < n.length; i++) nor.push(n[i]);
          if (geo.index) {
            const id = geo.index.array;
            for (let i = 0; i < id.length; i++) idx.push(id[i] + offset);
          } else {
            for (let i = 0; i < geo.attributes.position.count; i++) idx.push(offset + i);
          }
          offset += geo.attributes.position.count;
        }
        const out = new THREE.BufferGeometry();
        out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        if (nor.length === pos.length) out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
        else out.computeVertexNormals();
        out.setIndex(idx);
        out.computeBoundingSphere();
        return out;
      }
      function makeBranchingTrunk(segments) {
        const geos = [];
        const matrix = new THREE.Matrix4();
        const quat = new THREE.Quaternion();
        const scale = new THREE.Vector3(1, 1, 1);
        const seenJoints = [];
        function addJoint(x, y, z, r) {
          for (let i = 0; i < seenJoints.length; i++) {
            const j = seenJoints[i];
            if (Math.hypot(j.x - x, j.y - y, j.z - z) < 0.04) { if (r <= j.r) return; break; }
          }
          seenJoints.push({ x, y, z, r });
          const joint = new THREE.DodecahedronGeometry(r * 1.08, 0);
          joint.scale(1.0, 0.86, 1.0);
          joint.translate(x, y, z);
          geos.push(joint);
        }
        for (let i = 0; i < segments.length; i++) {
          const s = segments[i];
          const limb = new THREE.CylinderGeometry(s.r1, s.r0, s.len, 7, 1, true);
          limb.translate(0, s.len / 2, 0);
          _eul.set(s.rx, 0, s.rz);
          quat.setFromEuler(_eul);
          matrix.compose(new THREE.Vector3(s.x, s.y, s.z), quat, scale);
          limb.applyMatrix4(matrix);
          geos.push(limb);
          const tip = branchTip(s.x, s.y, s.z, s.len, s.rz, s.rx);
          addJoint(s.x, s.y, s.z, s.r0);
          addJoint(tip.x, tip.y, tip.z, s.r1);
        }
        const mesh = new THREE.Mesh(mergeBufferGeometries(geos), bM.trunk);
        mesh.castShadow = true; mesh.receiveShadow = true;
        useFrontShadowFaces(mesh.material);
        return mesh;
      }
      // a foliage CLUSTER = several faceted icosahedrons of varied size/shade clumped at a branch tip
      function foliage(g, x, y, z, scale, mainMat) {
        const blobs = [[0, 0.1, 0, 1.0], [0.6, 0.0, 0.25, 0.6], [-0.55, 0.05, -0.2, 0.55], [0.15, 0.6, -0.1, 0.62], [-0.2, 0.45, 0.35, 0.5]];
        for (let i = 0; i < blobs.length; i++) {
          const b = blobs[i];
          const mat = (i === 2 || i === 4) ? bM.canopyB : mainMat;
          const m = new THREE.Mesh(bG.canopy, mat);
          m.position.set(x + b[0] * scale, y + b[1] * scale, z + b[2] * scale);
          const s = b[3] * scale * (0.9 + Math.random() * 0.2); m.scale.set(s, s * 0.92, s);
          m.rotation.set(Math.random() * 0.6, Math.random() * 6.28, Math.random() * 0.6); m.castShadow = true; g.add(m);
        }
      }
      // backward-compat: old tree code calls clump(...) -> now a rich multi-blob cluster (no berries)
      function clump(g, x, y, z, rx, ry, rz, mat) { foliage(g, x, y, z, (rx + rz) * 0.42, mat); }
      function bm(geo, mat, parent, x, y, z, sx, sy, sz) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); if (sx !== undefined) m.scale.set(sx, sy, sz); m.castShadow = true; m.receiveShadow = true; useFrontShadowFaces(mat); parent.add(m); return m; }

      /* ---- tree model factory: distinct species for the build palette + ghost preview ---- */
      const TREE_KINDS = [
        { id: 'tree_s', label: '🌳 Small' },
        { id: 'tree_m', label: '🌳 Medium' },
        { id: 'tree_l', label: '🌳 Large' }
      ];
      // old models — OFF by default, can be activated in Settings to appear in the build menu
      const CLASSIC_KINDS = [
        { id: 'oak', label: '🌳 Oak' }, { id: 'bigoak', label: '🌳 Big Oak' }, { id: 'pine', label: '🌲 Pine' },
        { id: 'birch', label: '🪾 Birch' }, { id: 'palm', label: '🌴 Palm' }, { id: 'fruit', label: '🍎 Fruit' }
      ];
      let treeKindIdx = 0;
      function makeTreeModel(kind) {
        const g = new THREE.Group();
        if (kind === 'tree_s') {            // SMALL — flared base, forked, leafy crowns ON the branch tips
          const segs = [];
          const a = addTrunkSegment(segs, 0, 0, 0, 0.7, 0.5, 0.32, 0.06, 0);
          const t = addTrunkSegment(segs, a.x, a.y, a.z, 1.7, 0.3, 0.2, -0.05, 0);
          const r = addTrunkSegment(segs, t.x, t.y, t.z, 1.25, 0.17, 0.1, 0.6, 0.16);
          const l = addTrunkSegment(segs, t.x, t.y, t.z, 1.15, 0.16, 0.09, -0.55, -0.14);
          g.add(makeBranchingTrunk(segs));
          foliage(g, r.x, r.y, r.z, 1.35, bM.canopyA);
          foliage(g, l.x, l.y, l.z, 1.0, bM.canopyB);
          foliage(g, t.x, t.y + 0.45, t.z, 1.15, bM.canopyA);
        } else if (kind === 'tree_m') {     // MEDIUM — Y-fork into 3 limbs, each ending in a leafy crown
          const segs = [];
          const a = addTrunkSegment(segs, 0, 0, 0, 0.8, 0.55, 0.36, 0.07, 0);
          const t = addTrunkSegment(segs, a.x, a.y, a.z, 2.1, 0.34, 0.22, -0.05, 0);
          const r = addTrunkSegment(segs, t.x, t.y, t.z, 1.9, 0.22, 0.13, 0.52, 0.18);
          const l = addTrunkSegment(segs, t.x, t.y, t.z, 1.5, 0.2, 0.12, -0.74, -0.18);
          const c = addTrunkSegment(segs, t.x, t.y, t.z, 1.3, 0.18, 0.1, 0.06, -0.04);
          g.add(makeBranchingTrunk(segs));
          foliage(g, r.x, r.y, r.z, 1.7, bM.canopyA);
          foliage(g, l.x, l.y, l.z, 1.1, bM.canopyB);
          foliage(g, c.x, c.y, c.z, 1.3, bM.canopyA);
        } else if (kind === 'tree_l') {     // LARGE — thick bent trunk, 3 big limbs, each with its own crown
          const segs = [];
          const a = addTrunkSegment(segs, 0, 0, 0, 1.0, 0.72, 0.46, 0.05, 0);
          const t = addTrunkSegment(segs, a.x, a.y, a.z, 2.4, 0.44, 0.27, -0.04, 0);
          const c = addTrunkSegment(segs, t.x, t.y, t.z, 2.0, 0.26, 0.16, 0.1, 0.05);
          const r = addTrunkSegment(segs, t.x, t.y, t.z, 1.8, 0.22, 0.13, 0.64, 0.2);
          const l = addTrunkSegment(segs, t.x, t.y, t.z, 1.7, 0.2, 0.12, -0.66, -0.2);
          g.add(makeBranchingTrunk(segs));
          foliage(g, c.x, c.y, c.z, 2.05, bM.canopyA);
          foliage(g, r.x, r.y, r.z, 1.3, bM.canopyB);
          foliage(g, l.x, l.y, l.z, 1.3, bM.canopyA);
        } else if (kind === 'oak') {
          bm(bG.trunk, bM.trunk, g, 0, 0, 0, 1.1, 1.1, 1.1);
          bm(bG.ball, bM.leaf, g, 0, 5.4, 0, 1.7, 1.6, 1.7); bm(bG.ball, bM.leaf, g, 0.7, 6.7, -0.4, 0.95, 0.95, 0.95); bm(bG.ball, bM.leaf, g, -0.5, 6.5, 0.4, 0.8, 0.8, 0.8);
        } else if (kind === 'bigoak') {
          bm(bG.trunk, bM.trunk, g, 0, 0, 0, 1.5, 1.45, 1.5);
          const brG = new THREE.CylinderGeometry(0.16, 0.3, 3.4, 6);
          const b1 = bm(brG, bM.trunk, g, 1.0, 4.7, 0, 1, 1, 1); b1.rotation.z = -0.85;
          const b2 = bm(brG, bM.trunk, g, -1.0, 4.5, 0.3, 1, 1, 1); b2.rotation.z = 0.85; b2.rotation.x = 0.3;
          const b3 = bm(brG, bM.trunk, g, 0.2, 5.1, -1.0, 1, 1, 1); b3.rotation.x = -0.8;
          bm(bG.ball, bM.leaf, g, 0, 6.8, 0, 2.0, 1.7, 2.0);
          bm(bG.ball, bM.leaf, g, 1.9, 6.3, 0.2, 1.15, 1.05, 1.15);
          bm(bG.ball, bM.leaf, g, -1.8, 6.1, -0.3, 1.05, 1.0, 1.05);
          bm(bG.ball, bM.leaf, g, 0.2, 8.2, 0.1, 1.05, 1.0, 1.05);
        } else if (kind === 'pine') {
          bm(new THREE.CylinderGeometry(0.2, 0.32, 2, 6), bM.trunk, g, 0, 1, 0);
          bm(new THREE.ConeGeometry(1.7, 3.4, 7), bM.pine, g, 0, 3.4, 0); bm(new THREE.ConeGeometry(1.3, 2.8, 7), bM.pine, g, 0, 4.9, 0); bm(new THREE.ConeGeometry(0.85, 2.2, 7), bM.pine, g, 0, 6.2, 0);
        } else if (kind === 'birch') {
          bm(new THREE.CylinderGeometry(0.15, 0.22, 7.2, 6), bM.birch, g, 0, 3.6, 0);            // tall white trunk
          for (let k = 0; k < 6; k++) bm(new THREE.CylinderGeometry(0.165, 0.165, 0.12, 6), bM.birchMark, g, 0, 1.0 + k * 1.0, 0); // dark bands
          // SLENDER, tall, pointed crown (clearly different from the round oak)
          bm(bG.ball, bM.leaf2, g, 0, 6.2, 0, 0.9, 1.05, 0.9);
          bm(bG.ball, bM.leaf2, g, 0.15, 7.3, 0.1, 0.72, 0.95, 0.72);
          bm(bG.ball, bM.leaf2, g, -0.12, 8.2, -0.05, 0.52, 0.8, 0.52);
          bm(new THREE.ConeGeometry(0.55, 1.4, 7), bM.leaf2, g, 0, 9.0, 0);                      // pointed top
        } else if (kind === 'palm') {
          bm(new THREE.CylinderGeometry(0.16, 0.26, 6.2, 6), bM.trunk, g, 0, 3.1, 0);
          const frondG = new THREE.ConeGeometry(0.42, 3.6, 4); frondG.scale(1, 1, 0.14); frondG.translate(0, 1.8, 0);
          for (let f = 0; f < 8; f++) { const fr = new THREE.Mesh(frondG, bM.leaf); fr.castShadow = true; fr.position.set(0, 6.2, 0); fr.rotation.y = f / 8 * 6.283; fr.rotateX(-2.2); g.add(fr); }
        } else if (kind === 'fruit') {
          bm(bG.trunk, bM.trunk, g, 0, 0, 0);
          bm(bG.ball, bM.leaf, g, 0, 5.0, 0, 1.45, 1.35, 1.45); bm(bG.ball, bM.leaf, g, 0.5, 6.1, 0, 0.85, 0.85, 0.85);
          for (let k = 0; k < 11; k++) { const aa = Math.random() * 6.28, rr = 2.0 + Math.random() * 0.7; bm(new THREE.IcosahedronGeometry(0.34, 0), bM.fruit, g, Math.cos(aa) * rr, 4.6 + Math.random() * 1.8, Math.sin(aa) * rr); }
        }
        return g;
      }
      // translucent ghost preview that follows the cursor while placing trees
      const ghostMat = new THREE.MeshStandardMaterial({ color: 0x86f0ff, transparent: true, opacity: 0.5, depthWrite: false });
      let ghost = null;
      function rebuildGhost() { if (ghost) scene.remove(ghost); ghost = makeTreeModel(TREE_KINDS[treeKindIdx].id); ghost.traverse(o => { if (o.isMesh) o.material = ghostMat; }); ghost.visible = false; ghost.frustumCulled = false; scene.add(ghost); }
      function cycleTree(d) { treeKindIdx = (treeKindIdx + d + TREE_KINDS.length) % TREE_KINDS.length; rebuildGhost(); updateTreebar(); }
      function updateTreebar() { const el = document.getElementById('treebar'); if (!el) return; el.querySelectorAll('button').forEach((b, i) => b.classList.toggle('sel', i === treeKindIdx)); }
      function rebuildTreebar() {
        const tb = document.getElementById('treebar'); if (!tb) return;
        tb.querySelectorAll('button').forEach(b => b.remove());
        TREE_KINDS.forEach((k, i) => { const b = document.createElement('button'); b.textContent = k.label; b.addEventListener('click', () => { treeKindIdx = i; rebuildGhost(); updateTreebar(); }); tb.appendChild(b); });
        if (treeKindIdx >= TREE_KINDS.length) treeKindIdx = 0;
        rebuildGhost(); updateTreebar();
      }
      function buildAt(type, x, z, kind) {
        const h = heightAt(x, z);
        if (type === 'crystal') { // standalone, world-positioned, and collectible in FPS
          const m = new THREE.Mesh(bG.crystal, bM.crystal); m.position.set(x, h + 1.6, z); m.castShadow = true; useFrontShadowFaces(m.material); m.userData.type = 'crystal'; scene.add(m);
          placed.push(m); crystals.push({ mesh: m, baseY: h + 1.6, got: false });
          const tot = document.getElementById('total'); if (tot) tot.textContent = crystals.length;
          return m;
        }
        if (type === 'key') {
          const key = spawnKey(x, z, h);
          key.mesh.userData.type = 'key';
          key.mesh.userData.key = key;
          placed.push(key.mesh);
          return key.mesh;
        }
        if (type === 'chest') {
          const chest = makeChest(x, z, Math.random() * 6.28, h);
          chest.group.userData.type = 'chest';
          chest.group.userData.chest = chest;
          chest.group.userData.collider = chest.collider;
          placed.push(chest.group);
          return chest.group;
        }
        if (type === 'house' && worldMakeHouse) {   // same enterable, furnished, collidable house as the village
          const gh = worldMakeHouse(x, z, h, Math.random() * 6.28); normalizeShadowCastingMaterials(gh); gh.userData.type = 'house'; placed.push(gh); return gh;
        }
        const g = new THREE.Group(); g.position.set(x, h, z); const rot = Math.random() * 6.28; g.rotation.y = rot; scene.add(g);
        if (type === 'tree') { const tk = kind || TREE_KINDS[treeKindIdx].id; g.add(makeTreeModel(tk)); g.userData.kind = tk; }
        else if (type === 'rock') {
          const s = 0.7 + Math.random() * 1.7;
          bm(Math.random() < 0.5 ? bG.rock : bG.rock2, bM.rock, g, 0, s * 0.3, 0, s, s * (0.6 + Math.random() * 0.5), s);
          const collider = { x, z, r: s * 0.7 };
          colliders.push(collider);
          g.userData.collider = collider;
        }
        else if (type === 'bush') { const s = 0.8 + Math.random() * 0.6; bm(bG.ball, bM.bush, g, 0, 0.7 * s, 0, s * 0.55, s * 0.5, s * 0.55); bm(bG.ball, bM.bush, g, 0.5 * s, 0.6 * s, 0.2 * s, s * 0.38, s * 0.36, s * 0.38); bm(bG.ball, bM.bush, g, -0.45 * s, 0.62 * s, -0.2 * s, s * 0.34, s * 0.32, s * 0.34); }
        g.userData.type = type; placed.push(g); return g;
      }
      function removeFromArray(arr, item) { const i = arr.indexOf(item); if (i >= 0) arr.splice(i, 1); }
      function removePlacedObject(p) {
        if (!p) return;
        const type = p.userData.type;
        if (type === 'house') {
          for (let j = houses.length - 1; j >= 0; j--) if (Math.abs(houses[j].x - p.position.x) < 0.5 && Math.abs(houses[j].z - p.position.z) < 0.5) houses.splice(j, 1);
        }
        if (type === 'crystal') {
          for (let j = crystals.length - 1; j >= 0; j--) if (crystals[j].mesh === p) crystals.splice(j, 1);
          const tot = document.getElementById('total'); if (tot) tot.textContent = crystals.length;
        }
        if (type === 'key' && p.userData.key) removeFromArray(keysArr, p.userData.key);
        if (type === 'chest' && p.userData.chest) removeFromArray(chests, p.userData.chest);
        if (p.userData.collider) removeFromArray(colliders, p.userData.collider);
        scene.remove(p);
      }
      function eraseNear(x, z) { let bi = -1, bd = 8; for (let i = 0; i < placed.length; i++) { const p = placed[i], d = Math.hypot(p.position.x - x, p.position.z - z); if (d < bd) { bd = d; bi = i; } } if (bi >= 0) { const p = placed[bi]; removePlacedObject(p); placed.splice(bi, 1); } }
      function placeAtCursor() { if (!lastHit) return; if (tool === 'erase') eraseNear(lastHit.x, lastHit.z); else buildAt(tool, lastHit.x, lastHit.z); }
      function selectTool(t) {
        tool = t; document.querySelectorAll('#builderbar button[data-t]').forEach(b => b.classList.toggle('sel', b.dataset.t === t));
        const tb = document.getElementById('treebar'); if (tb) tb.classList.toggle('hidden', !(t === 'tree' && mode === 'god'));
        if (t !== 'tree' && ghost) ghost.visible = false;
      }
      function clearBuild() { while (placed.length) removePlacedObject(placed.pop()); }
      function saveBuild() { try { localStorage.setItem('vi_build', JSON.stringify(placed.map(p => ({ t: p.userData.type, k: p.userData.kind, x: +p.position.x.toFixed(2), z: +p.position.z.toFixed(2) })))); } catch (e) { } }
      function loadBuild() { try { const a = JSON.parse(localStorage.getItem('vi_build')); if (!a) return; clearBuild(); a.forEach(o => buildAt(o.t, o.x, o.z, o.k)); } catch (e) { } }

      /* ---- quests ---- */
      const quests = [
        { label: 'Collect 5 crystals', goal: 5, get: () => score, done: false },
        { label: 'Plant 4 trees', goal: 4, get: () => placed.filter(p => p.userData.type === 'tree').length, done: false },
        { label: 'Build a house', goal: 1, get: () => placed.filter(p => p.userData.type === 'house').length, done: false },
        { label: 'Place 3 rocks', goal: 3, get: () => placed.filter(p => p.userData.type === 'rock').length, done: false },
        { label: 'Defeat 3 slimes', goal: 3, get: () => kills, done: false }
      ];
      function renderQuests() {
        const el = document.getElementById('quests'); if (!el) return;
        let html = '<b>QUESTS</b>';
        quests.forEach(q => { const p = Math.min(q.goal, q.get()), ok = p >= q.goal; if (ok && !q.done) { q.done = true; sfxCollect(); } html += `<div class="${ok ? 'qdone' : ''}">${ok ? '✓' : '•'} ${q.label}<span>${p}/${q.goal}</span></div>`; });
        el.innerHTML = html;
      }
      function updateGod(dt) {
        const sp = ((keys['ShiftLeft'] || keys['ShiftRight']) ? 100 : 52) * dt;
        const fwdX = -Math.sin(godYaw), fwdZ = -Math.cos(godYaw), rgtX = Math.cos(godYaw), rgtZ = -Math.sin(godYaw);
        let mvx = 0, mvz = 0;
        if (keys['KeyW']) { mvx += fwdX; mvz += fwdZ; } if (keys['KeyS']) { mvx -= fwdX; mvz -= fwdZ; }
        if (keys['KeyD']) { mvx += rgtX; mvz += rgtZ; } if (keys['KeyA']) { mvx -= rgtX; mvz -= rgtZ; }
        const ml = Math.hypot(mvx, mvz); if (ml > 0) { godTarget.x += mvx / ml * sp; godTarget.z += mvz / ml * sp; }
        if (keys['KeyQ']) godYaw += dt * 1.3; if (keys['KeyE']) godYaw -= dt * 1.3;
        const lim = WORLD * 0.5 - 6; godTarget.x = Math.max(-lim, Math.min(lim, godTarget.x)); godTarget.z = Math.max(-lim, Math.min(lim, godTarget.z));
        godTarget.y = heightAt(godTarget.x, godTarget.z);
        const cp = Math.cos(godPitch);
        godCam.position.set(godTarget.x + Math.sin(godYaw) * cp * godDist, godTarget.y + Math.sin(godPitch) * godDist, godTarget.z + Math.cos(godYaw) * cp * godDist);
        godCam.lookAt(godTarget);
        _ray.setFromCamera(_ndc, godCam); const hit = _ray.intersectObject(terrainMesh, false);
        if (hit.length) { cursor.visible = true; lastHit = hit[0].point.clone(); updateCursorRing(lastHit.x, lastHit.z); } else cursor.visible = false;
        if (tool === 'tree' && ghost && hit.length) { ghost.visible = true; ghost.position.copy(hit[0].point); } else if (ghost) ghost.visible = false;
      }
      function setMode(m, options = {}) {
        mode = m;
        document.getElementById('builderbar').classList.toggle('hidden', m !== 'god');
        document.getElementById('modeTag').textContent = m === 'god' ? 'BUILD' : 'EXPLORE';
        document.getElementById('crosshair').style.display = m === 'god' ? 'none' : 'block';
        if (typeof vm !== 'undefined' && vm) vm.visible = (m === 'fps');
        cursor.visible = false;
        const tb = document.getElementById('treebar'); if (tb) tb.classList.toggle('hidden', !(m === 'god' && tool === 'tree'));
        if (ghost && m !== 'god') ghost.visible = false;
        if (m === 'god') {
          if (!options.preserveGodTarget) godTarget.set(player.position.x, 0, player.position.z);
          godCam.aspect = innerWidth / innerHeight;
          godCam.updateProjectionMatrix();
        }
      }
      function enterBuildMode() {
        if (inMainMenu || paused || anyOverlayOpen() || menuCameraTransitionActive()) return;
        clearDelayedPointerLockTimer();
        pointerLockPending = false;
        keepPlayingOnPointerLockFailure = false;
        suppressNextUnlockPauseMenu = false;
        pausedFromBuildMode = false;
        _hideOverlays();
        hideMenuOverlayNow();
        cancelMenuCameraTransition();
        setPausedState(false);
        setMode('god');
        if (hasGamePointerLock() && document.exitPointerLock) {
          suppressBuildUnlockPauseMenu = true;
          document.exitPointerLock();
        }
      }
      function exitBuildMode() {
        if (mode !== 'god' || inMainMenu || anyOverlayOpen() || menuCameraTransitionActive()) return;
        clearDelayedPointerLockTimer();
        pointerLockPending = false;
        keepPlayingOnPointerLockFailure = false;
        suppressNextUnlockPauseMenu = false;
        suppressBuildUnlockPauseMenu = false;
        pausedFromBuildMode = false;
        _hideOverlays();
        hideMenuOverlayNow();
        clearInputState();
        setPausedState(false);
        beginResumeCameraTransitionFromCamera(godCam);
        setMode('fps');
        scheduleGamePointerLock(CONTINUE_RELOCK_DELAY_MS);
      }
      function pauseFromBuildMode() {
        if (mode !== 'god' || inMainMenu || anyOverlayOpen() || menuCameraTransitionActive()) return;
        clearDelayedPointerLockTimer();
        pointerLockPending = false;
        keepPlayingOnPointerLockFailure = false;
        suppressNextUnlockPauseMenu = false;
        suppressBuildUnlockPauseMenu = false;
        pausedFromBuildMode = true;
        _hideOverlays();
        hideMenuOverlayNow();
        clearInputState();
        beginPauseCameraTransitionFromCamera(godCam);
        setMode('fps');
        document.getElementById('startupButtons').classList.add('hidden-group');
        document.getElementById('pausedButtons').classList.remove('hidden-group');
        overlay.classList.remove('hide');
        overlay.style.display = 'flex';
        syncMenuOverlayChrome();
        setPausedState(true);
      }
      addEventListener('keydown', e => {
        if (typing()) return;
        if (menuOverlayVisible()) { clearInputState(); return; }
        if (e.code === 'KeyG') {
          if (e.repeat) return;
          e.preventDefault();
          if (mode === 'god') exitBuildMode();
          else enterBuildMode();
          return;
        }
        if (mode === 'god' && !paused && !anyOverlayOpen()) {
          const map = { Digit1: 'tree', Digit2: 'rock', Digit3: 'bush', Digit4: 'house', Digit5: 'crystal', Digit6: 'key', Digit7: 'chest', Digit8: 'erase' }; if (map[e.code]) selectTool(map[e.code]);
          if (tool === 'tree') { if (e.code === 'Comma') cycleTree(-1); if (e.code === 'Period') cycleTree(1); }
        }
      });
      addEventListener('wheel', e => { if (mode === 'god') godDist = Math.max(24, Math.min(280, godDist + e.deltaY * 0.06)); }, { passive: true });
      addEventListener('mousemove', e => { _ndc.x = (e.clientX / innerWidth) * 2 - 1; _ndc.y = -(e.clientY / innerHeight) * 2 + 1; });
      document.querySelectorAll('#builderbar button[data-t]').forEach(b => b.addEventListener('click', () => selectTool(b.dataset.t)));
      document.querySelectorAll('#builderbar button[data-act]').forEach(b => b.addEventListener('click', () => { const a = b.dataset.act; if (a === 'save') saveBuild(); else if (a === 'load') loadBuild(); else if (a === 'clear') clearBuild(); }));
      rebuildTreebar();
      // scatter ONLY the new trees (small / medium / large) across the world
      (function () {
        const NK = ['tree_s', 'tree_m', 'tree_l']; let made = 0;
        for (let i = 0; i < 400 && made < 46; i++) {
          const x = (rnd() - 0.5) * WORLD * 0.82, z = (rnd() - 0.5) * WORLD * 0.82, h = heightAt(x, z);
          if (h < WATER + 1.6) continue;
          const hx = heightAt(x + 2.5, z) - heightAt(x - 2.5, z), hz = heightAt(x, z + 2.5) - heightAt(x, z - 2.5);
          if (Math.hypot(hx, hz) > 3.2) continue;
          const m = makeTreeModel(NK[(rnd() * 3) | 0]);
          m.position.set(x, h, z); m.rotation.y = rnd() * 6.28; m.scale.setScalar(0.75 + rnd() * 0.6);
          scene.add(m); made++;
        }
      })();

      /* ambient floating motes */
      const motes = (function () {
        const N = 260, g = new THREE.BufferGeometry(), pos = new Float32Array(N * 3), spd = new Float32Array(N);
        for (let i = 0; i < N; i++) { pos[i * 3] = (rnd() - 0.5) * WORLD * 0.8; pos[i * 3 + 1] = 6 + rnd() * 32; pos[i * 3 + 2] = (rnd() - 0.5) * WORLD * 0.8; spd[i] = 0.25 + rnd() * 0.7; }
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const m = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xfff2c0, size: 0.5, transparent: true, opacity: 0.7, depthWrite: false }));
        m.frustumCulled = false; scene.add(m); return { pts: m, pos, spd, N };
      })();

      /* movement state */
      const vel = new THREE.Vector3();
      let vy = 0, onGround = false, bob = 0, stepAcc = 0, inWaterPrev = false, _waveAcc = 0, air = 1, _qAcc = 0;
      let parrotMode = false, controlledParrot = null;
      const parrotSaved = { px: 0, py: 0, pz: 0, yaw: 0, pitch: 0, vy: 0 };
      const parrotVel = new THREE.Vector3();
      function respawn() { player.position.set(0, heightAt(0, 0) + EYE, 30); vel.set(0, 0, 0); vy = 0; air = 1; }
      // nearest distance to open water (for spatial wave volume)
      function waterProximity(px, pz) {
        if (heightAt(px, pz) < WATER + 0.5) return 0;
        let best = 999;
        for (let a = 0; a < 8; a++) {
          const ang = a / 8 * 6.283, dx = Math.cos(ang), dz = Math.sin(ang);
          for (let d = 6; d <= 120; d += 6) { if (heightAt(px + dx * d, pz + dz * d) < WATER) { if (d < best) best = d; break; } }
        }
        return best;
      }

      /* ============================================================
         ENEMIES + COMBAT  (roaming slimes, click to attack with the torch)
         ============================================================ */
      const enemies = [];
      let playerHP = 100, kills = 0, swingT = 0, hurtFlash = 0, playerDmg = 1, keysHeld = 0, gold = 0;
      let attackAnim = 'punch';
      const _slimeG = new THREE.IcosahedronGeometry(0.62, 1);
      const _slimeMats = [new THREE.MeshStandardMaterial({ color: 0x7ac74f, roughness: 0.55, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0xb05fd6, roughness: 0.55, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0xe0913a, roughness: 0.55, flatShading: true })];
      const _eyeG = new THREE.SphereGeometry(0.09, 6, 6), _eyeMat = new THREE.MeshStandardMaterial({ color: 0x16110f, roughness: 0.4 });
      function spawnSlime(x, z) {
        const g = new THREE.Group(); g.position.set(x, Math.max(heightAt(x, z), WATER), z);
        const body = new THREE.Mesh(_slimeG, _slimeMats[(Math.random() * _slimeMats.length) | 0]); body.position.y = 0.55; body.castShadow = true; g.add(body);
        const e1 = new THREE.Mesh(_eyeG, _eyeMat); e1.position.set(0.2, 0.7, 0.5); body.add(e1);
        const e2 = new THREE.Mesh(_eyeG, _eyeMat); e2.position.set(-0.2, 0.7, 0.5); body.add(e2);
        g.userData = { body, hp: 3, ang: Math.random() * 6.28, t: Math.random() * 9, dir: 1 + Math.random() * 3, cd: 0 };
        scene.add(g); enemies.push(g);
      }
      for (let i = 0; i < 9; i++) { for (let tr = 0; tr < 50; tr++) { const x = (rnd() - 0.5) * WORLD * 0.6, z = (rnd() - 0.5) * WORLD * 0.6; if (heightAt(x, z) > WATER + 1.5) { spawnSlime(x, z); break; } } }
      function hurtPlayer(n) { playerHP -= n; hurtFlash = 0.15; const d = document.getElementById('dmg'); if (d) { d.classList.add('hit'); setTimeout(() => d.classList.remove('hit'), 120); } if (playerHP <= 0) { playerHP = 100; respawn(); } const e = document.getElementById('hpNum'); if (e) e.textContent = Math.max(0, playerHP | 0); }

      /* ============================================================
         TREASURE — golden keys + lockable chests with loot
         ============================================================ */
      const keysArr = [], chests = [];
      const _goldMat = new THREE.MeshStandardMaterial({ color: 0xffcf3a, metalness: 0.7, roughness: 0.3, emissive: 0x4a3500, emissiveIntensity: 0.45 });
      const _chestWood = new THREE.MeshStandardMaterial({ color: 0x7a4a22, roughness: 0.85, flatShading: true });
      const _chestMetal = new THREE.MeshStandardMaterial({ color: 0xd9c24a, metalness: 0.6, roughness: 0.4 });
      const WEAPONS = ['Iron Sword', 'Battle Axe', 'War Hammer', 'Bronze Dagger', 'Spiked Mace'];
      function makeKeyMesh() {
        const g = new THREE.Group();
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.055, 8, 16), _goldMat); ring.rotation.y = Math.PI / 2; g.add(ring);
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), _goldMat); shaft.position.y = -0.33; g.add(shaft);
        const t1 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.18), _goldMat); t1.position.set(0, -0.5, 0.09); g.add(t1);
        const t2 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.13), _goldMat); t2.position.set(0, -0.42, 0.08); g.add(t2);
        g.children.forEach(c => c.castShadow = true); return g;
      }
      function spawnKey(x, z, h) {
        const yy = (h !== undefined ? h : heightAt(x, z)) + 1.3;
        const m = makeKeyMesh();
        m.position.set(x, yy, z);
        scene.add(m);
        const key = { mesh: m, baseY: yy, got: false };
        keysArr.push(key);
        return key;
      }
      function makeChest(x, z, rot, y) {
        const g = new THREE.Group(); g.position.set(x, (y !== undefined ? y : heightAt(x, z)), z); g.rotation.y = rot || 0; scene.add(g);
        const tw = 0.12;
        function wood(w, h, d, px, py, pz) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), _chestWood); m.position.set(px, py, pz); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; }
        wood(1.3, 0.12, 0.9, 0, 0.06, 0);          // floor of the chest
        wood(1.3, 0.58, tw, 0, 0.41, -0.39);        // back wall
        wood(1.3, 0.58, tw, 0, 0.41, 0.39);         // front wall  -> interior is hollow
        wood(tw, 0.58, 0.9, -0.59, 0.41, 0);        // left wall
        wood(tw, 0.58, 0.9, 0.59, 0.41, 0);         // right wall
        for (const bx of [-0.45, 0.45]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.62, tw + 0.05), _chestMetal); b.position.set(bx, 0.41, 0.4); g.add(b); }
        const lock = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.24, 0.09), _chestMetal); lock.position.set(0, 0.55, 0.46); g.add(lock);
        const lid = new THREE.Group(); lid.position.set(0, 0.7, -0.45); g.add(lid);   // hinge at the back-top
        const lidBox = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.26, 0.9), _chestWood); lidBox.position.set(0, 0.13, 0.45); lidBox.castShadow = true; lid.add(lidBox);
        for (const bx of [-0.45, 0.45]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.94), _chestMetal); b.position.set(bx, 0.13, 0.45); lid.add(b); }
        // treasure piled on the floor inside — hidden once the chest is opened and looted
        const pile = new THREE.Group(); pile.position.set(0, 0.14, 0); g.add(pile);
        for (const p of [[-0.22, 0.08, 0.13], [0.18, -0.08, 0.12], [0.0, 0.16, 0.11], [0.26, 0.14, 0.1], [-0.24, -0.16, 0.1], [0.06, -0.04, 0.12]]) { const m = new THREE.Mesh(new THREE.SphereGeometry(p[2], 6, 5), _goldMat); m.position.set(p[0], p[2] * 0.6, p[1]); pile.add(m); }
        const collider = { x, z, r: 0.85 };
        const c = { group: g, lid, pile, x, z, y: (y !== undefined ? y : heightAt(x, z)), opened: false, openAmt: 0, collider };
        chests.push(c);
        colliders.push(collider);
        normalizeShadowCastingMaterials(g);
        return c;
      }
      // a chest inside every cottage, plus a few hidden outdoors
      for (let i = 0; i < houses.length; i++) { const H = houses[i], lx = 1.7, lz = -2.3; const cx = H.x + Math.cos(H.rot) * lx + Math.sin(H.rot) * lz, cz = H.z - Math.sin(H.rot) * lx + Math.cos(H.rot) * lz; makeChest(cx, cz, H.rot, H.y + 1.1); }
      for (let i = 0; i < 5; i++) { for (let tr = 0; tr < 40; tr++) { const x = (rnd() - 0.5) * WORLD * 0.7, z = (rnd() - 0.5) * WORLD * 0.7; const h = placeOK(x, z, WATER + 1.5, 7); if (h !== null) { makeChest(x, z, rnd() * 6.28, h); break; } } }
      // golden keys scattered across the island
      for (let i = 0; i < 14; i++) { for (let tr = 0; tr < 40; tr++) { const x = (rnd() - 0.5) * WORLD * 0.82, z = (rnd() - 0.5) * WORLD * 0.82; const h = placeOK(x, z, WATER + 1.2, 5); if (h !== null) { spawnKey(x, z, h); break; } } }

      let _toastT = null;
      function toast(s) { const el = document.getElementById('toast'); if (!el) return; el.textContent = s; el.classList.add('show'); clearTimeout(_toastT); _toastT = setTimeout(() => el.classList.remove('show'), 3400); }
      function updateTreasureHUD() { const k = document.getElementById('keysNum'), gN = document.getElementById('goldNum'); if (k) k.textContent = keysHeld; if (gN) gN.textContent = gold; }
      /* ---- inventory + flying-loot effects ---- */
      const inventory = {}; let equippedWeapon = null;
      const WEAPON_DMG = { 'Iron Sword': 2, 'Battle Axe': 3, 'War Hammer': 4, 'Bronze Dagger': 2, 'Spiked Mace': 3 };
      function addItem(it) { const cur = inventory[it.id]; if (cur) cur.count += (it.count || 1); else inventory[it.id] = Object.assign({ count: it.count || 1 }, it); renderInv(); }
      function useItem(id) {
        const it = inventory[id]; if (!it) return;
        if (it.kind === 'consumable') { playerHP = Math.min(100, playerHP + (it.heal || 40)); const e = document.getElementById('hpNum'); if (e) e.textContent = playerHP | 0; it.count--; toast('🧰 Used ' + it.name + ' (+' + (it.heal || 40) + ' HP)'); if (it.count <= 0) delete inventory[id]; sfxCollect(); }
        else if (it.kind === 'weapon') { equippedWeapon = it; playerDmg = it.dmg || 1; const e = document.getElementById('eqW'); if (e) e.textContent = it.name; toast('🗡 Equipped ' + it.name + ' (attack ' + playerDmg + ')'); }
        renderInv();
      }
      function renderInv() {
        const grid = document.getElementById('invGrid'); if (!grid) return; grid.innerHTML = '';
        const ids = Object.keys(inventory);
        if (!ids.length) { grid.innerHTML = '<div class="invEmpty">Empty — open treasure chests to find weapons, kits and loot.</div>'; return; }
        for (const id of ids) { const it = inventory[id]; const s = document.createElement('div'); s.className = 'invSlot' + (equippedWeapon && equippedWeapon.id === id ? ' eq' : ''); s.innerHTML = '<div class="ic">' + it.icon + '</div><div class="nm">' + it.name + '</div>' + (it.count > 1 ? '<div class="ct">' + it.count + '</div>' : ''); s.addEventListener('click', () => useItem(id)); grid.appendChild(s); }
      }
      const lootFx = []; const _emojiTex = {};
      function emojiTexture(ch) { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); x.font = '48px serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ch, 32, 36); return new THREE.CanvasTexture(c); }
      function spawnLootFx(ch, chest) {
        if (!_emojiTex[ch]) _emojiTex[ch] = emojiTexture(ch);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: _emojiTex[ch], transparent: true, depthTest: false })); sp.scale.set(0.9, 0.9, 0.9);
        const sx = chest ? chest.x : player.position.x, sz = chest ? chest.z : player.position.z, sy = (chest ? chest.y + 1.1 : player.position.y + 1);
        sp.position.set(sx, sy, sz); scene.add(sp);
        lootFx.push({ sp, age: 0, sx, sz, sy });
      }
      function updateLootFx(dt) {
        for (let i = lootFx.length - 1; i >= 0; i--) {
          const f = lootFx[i]; f.age += dt; const p = Math.min(1, f.age / 1.1);
          const tx = player.position.x, tz = player.position.z, ty = player.position.y + 1.5;
          f.sp.position.x = f.sx + (tx - f.sx) * p; f.sp.position.z = f.sz + (tz - f.sz) * p;
          f.sp.position.y = f.sy + Math.sin(p * Math.PI) * 1.8 + (ty - f.sy) * p;
          const s = 0.95 * (1 - p * 0.55); f.sp.scale.set(s, s, s); f.sp.material.opacity = 1 - p * p;
          if (f.age >= 1.1) { scene.remove(f.sp); f.sp.material.dispose(); lootFx.splice(i, 1); }
        }
      }
      function grantLoot(chest) {
        const rolls = 1 + (Math.random() < 0.55 ? 1 : 0), msgs = [];
        for (let i = 0; i < rolls; i++) {
          const r = Math.random();
          if (r < 0.4) { const c = 20 + (Math.random() * 60 | 0); gold += c; msgs.push('🪙 ' + c + ' gold'); spawnLootFx('🪙', chest); }
          else if (r < 0.6) { const s = 5 + (Math.random() * 20 | 0); gold += s; msgs.push('💰 ' + s + ' silver'); spawnLootFx('💰', chest); }
          else if (r < 0.78) { addItem({ id: 'medkit', name: 'First-aid Kit', icon: '🧰', kind: 'consumable', heal: 40 }); msgs.push('🧰 First-aid Kit'); spawnLootFx('🧰', chest); }
          else { const n = WEAPONS[(Math.random() * WEAPONS.length) | 0]; addItem({ id: 'w_' + n, name: n, icon: '⚔️', kind: 'weapon', dmg: WEAPON_DMG[n] || 2 }); msgs.push('⚔ ' + n); spawnLootFx('⚔️', chest); }
        }
        toast('Chest opened!  ' + msgs.join('   ·   ')); updateTreasureHUD();
      }
      function tryOpenChest() {
        let best = null, bd = 3.2;
        for (let i = 0; i < chests.length; i++) { const c = chests[i]; if (c.opened) continue; const d = Math.hypot(player.position.x - c.x, player.position.z - c.z); if (d < bd) { bd = d; best = c; } }
        if (!best) return;
        if (keysHeld <= 0) { toast('🔒 Locked — you need a golden key'); return; }
        keysHeld--; best.opened = true; sfxCollect(); grantLoot(best); if (best.pile) best.pile.visible = false;
      }

      /* ============================================================
         WILDLIFE — circling birds, hopping rabbits, grazing deer
         ============================================================ */
      const birds = [], critters = [], parrots = [], groundAnimals = [];

      /* ---- Wildlife population control (Settings -> Wildlife debug) ----------
         Default: nothing is spawned. The user enables individual species and
         sets a per-species instance count, then hits "Apply wildlife". This lets
         us isolate which model/species causes a given problem. */
      const WILDLIFE_DEFS = [
        { key: 'bird',   label: 'Birds',   desc: 'Procedural low-poly birds',  def: 14 },
        { key: 'rabbit', label: 'Rabbits', desc: 'Procedural rabbits',         def: 10 },
        { key: 'parrot', label: 'Parrots', desc: 'GLTF animated parrot flock', def: 9 },
        { key: 'horse',  label: 'Horse',   desc: 'FBX horse',                  def: 4 },
        { key: 'deer',   label: 'Deer',    desc: 'FBX deer (antlerless)',      def: 5 }
      ];
      const wildlifeCounts = (() => {
        const d = {};
        WILDLIFE_DEFS.forEach(w => { d[w.key] = { on: false, n: w.def }; });
        try {
          const s = JSON.parse(localStorage.getItem('vi_wildlife') || 'null');
          if (s) WILDLIFE_DEFS.forEach(w => { if (s[w.key]) d[w.key] = { on: !!s[w.key].on, n: Math.max(0, Math.min(200, s[w.key].n | 0)) }; });
        } catch (e) {}
        return d;
      })();
      function wcount(key) { const c = wildlifeCounts[key]; return c && c.on ? c.n : 0; }
      function saveWildlifeCounts() { try { localStorage.setItem('vi_wildlife', JSON.stringify(wildlifeCounts)); } catch (e) {} }
      function clearWildlife(arr) { for (let i = 0; i < arr.length; i++) if (arr[i].g) scene.remove(arr[i].g); arr.length = 0; }
      let spawnBirds, spawnRabbits, spawnParrots;

      (function () {
        const birdMat = new THREE.MeshStandardMaterial({ color: 0x33373d, roughness: 0.7, flatShading: true });
        function makeBird() {
          const g = new THREE.Group();
          const bod = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.6, 6), birdMat); bod.rotation.x = -Math.PI / 2; g.add(bod);
          const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), birdMat); head.position.z = 0.34; g.add(head);
          const wl = new THREE.Group(), wr = new THREE.Group(); g.add(wl, wr);
          const wlm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.03, 0.28), birdMat); wlm.position.x = -0.38; wl.add(wlm);
          const wrm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.03, 0.28), birdMat); wrm.position.x = 0.38; wr.add(wrm);
          scene.add(g);
          return { g, wl, wr, cx: (rnd() - 0.5) * WORLD * 0.7, cz: (rnd() - 0.5) * WORLD * 0.7, r: 18 + rnd() * 46, ang: rnd() * 6.28, sp: 0.22 + rnd() * 0.3, hgt: 30 + rnd() * 34, flap: 8 + rnd() * 6, fph: rnd() * 6.28 };
        }
        spawnBirds = function () { clearWildlife(birds); const n = wcount('bird'); for (let i = 0; i < n; i++) birds.push(makeBird()); };

        const furBrown = new THREE.MeshStandardMaterial({ color: 0x9c6b40, roughness: 0.95, flatShading: true });
        const furWhite = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.95, flatShading: true });
        function part(w, h, d, mat, x, y, z, parent) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; }
        function mkCritter(g, legs, type, sp) { const x = (rnd() - 0.5) * WORLD * 0.7, z = (rnd() - 0.5) * WORLD * 0.7; g.position.set(x, heightAt(x, z), z); return { g, legs, type, sp, ang: rnd() * 6.28, t: rnd() * 9, dir: 1 + rnd() * 3, hop: rnd() * 6.28 }; }
        function makeRabbit() {
          const g = new THREE.Group();
          part(0.4, 0.34, 0.6, furBrown, 0, 0.32, 0, g);
          part(0.3, 0.3, 0.32, furBrown, 0, 0.5, 0.36, g);
          part(0.08, 0.3, 0.05, furBrown, -0.08, 0.78, 0.34, g); part(0.08, 0.3, 0.05, furBrown, 0.08, 0.78, 0.34, g);
          part(0.14, 0.14, 0.14, furWhite, 0, 0.3, -0.34, g);
          const legs = []; for (const sx of [-0.13, 0.13]) { legs.push(part(0.1, 0.22, 0.16, furBrown, sx, 0.13, -0.18, g)); legs.push(part(0.1, 0.18, 0.14, furBrown, sx, 0.13, 0.22, g)); }
          scene.add(g); return mkCritter(g, legs, 'rabbit', 4.0);
        }
        spawnRabbits = function () { clearWildlife(critters); const n = wcount('rabbit'); for (let i = 0; i < n; i++) { for (let tr = 0; tr < 30; tr++) { const r = makeRabbit(); if (heightAt(r.g.position.x, r.g.position.z) > WATER + 0.5) { critters.push(r); break; } else scene.remove(r.g); } } };
      })();
      let _parrotGltf = null, _parrotLoading = false;
      spawnParrots = function () {
        clearWildlife(parrots);
        const n = wcount('parrot');
        if (n <= 0) return;
        if (!_parrotGltf) {
          if (_parrotLoading || !THREE.GLTFLoader) return;
          _parrotLoading = true;
          new THREE.GLTFLoader().load('models/Flying_Parrot_Animated.glb', gltf => {
            gltf.scene.traverse(o => {
              if (!o.isMesh) return;
              o.castShadow = true;
              o.receiveShadow = false;
              o.frustumCulled = false;
              if (o.material) {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach(m => { m.roughness = Math.max(0.55, m.roughness || 0.55); m.needsUpdate = true; });
              }
            });
            _parrotGltf = gltf; _parrotLoading = false;
            spawnParrots(); // re-run now that the model is cached
          }, undefined, err => { _parrotLoading = false; console.warn('Could not load Flying_Parrot_Animated.glb', err); });
          return;
        }
        const gltf = _parrotGltf, clip = gltf.animations && gltf.animations[0];
        for (let i = 0; i < n; i++) {
          const g = new THREE.Group();
          const model = gltf.scene.clone(true);
          model.scale.setScalar(0.034 + rnd() * 0.012);
          g.add(model);
          scene.add(g);
          const mixer = clip ? new THREE.AnimationMixer(model) : null;
          if (mixer) {
            const action = mixer.clipAction(clip);
            action.timeScale = 0.85 + rnd() * 0.5;
            action.play();
            mixer.setTime(rnd() * clip.duration);
          }
          const parrot = {
            g, model, mixer,
            cx: (rnd() - 0.5) * WORLD * 0.58,
            cz: (rnd() - 0.5) * WORLD * 0.58,
            r: 34 + rnd() * 68,
            ang: rnd() * 6.28,
            sp: 0.12 + rnd() * 0.16,
            hgt: 38 + rnd() * 30,
            phase: rnd() * 6.28,
            driftX: 6 + rnd() * 10,
            driftZ: 6 + rnd() * 10
          };
          cacheAnimalShadowMeshes(parrot);
          parrot.shadowReceive = false;
          parrots.push(parrot);
        }
      };
      function toggleParrotMode() {
        if (parrotMode) {
          parrotMode = false;
          player.position.set(parrotSaved.px, parrotSaved.py, parrotSaved.pz);
          yaw = parrotSaved.yaw; pitch = parrotSaved.pitch; vy = parrotSaved.vy;
          vel.set(0, 0, 0);
          controlledParrot = null;
        } else {
          if (!parrots.length) return;
          let best = null, bestD2 = Infinity;
          for (const p of parrots) {
            const dx = p.g.position.x - player.position.x, dy = p.g.position.y - player.position.y, dz = p.g.position.z - player.position.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < bestD2) { bestD2 = d2; best = p; }
          }
          if (!best) return;
          parrotSaved.px = player.position.x; parrotSaved.py = player.position.y; parrotSaved.pz = player.position.z;
          parrotSaved.yaw = yaw; parrotSaved.pitch = pitch; parrotSaved.vy = vy;
          parrotMode = true; controlledParrot = best;
          parrotVel.set(0, 0, 0); vel.set(0, 0, 0); vy = 0;
          player.position.copy(best.g.position);
        }
      }
      function fbxClip(clips, patterns) {
        for (let i = 0; i < patterns.length; i++) {
          const rx = patterns[i];
          const clip = clips.find(c => rx.test(c.name || ''));
          if (clip) return clip;
        }
        return clips[0] || null;
      }
      // Some FBX clips carry "root motion" — the clip itself slides the rig root
      // forward (and wraps it back each loop). Strip only a true rig-root position
      // track. Picking the largest position track is unsafe for quadrupeds because
      // their leg IK targets legitimately move far during gallop and jump cycles.
      const ROOT_MOTION_TRACK_RE = /^(root|armature|animalarmature|hips|pelvis|mixamorighips|mixamorig:hips)$/i;
      function rootMotionNodeName(trackName) {
        if (!trackName || !trackName.endsWith('.position')) return '';
        const path = trackName.slice(0, -'.position'.length);
        const dot = path.lastIndexOf('.');
        return dot >= 0 ? path.slice(dot + 1) : path;
      }
      function stripRootMotion(clip) {
        if (!clip || !clip.tracks || clip._rootStripped) return clip;
        let worst = null, maxDisp = 0;
        for (let i = 0; i < clip.tracks.length; i++) {
          const tr = clip.tracks[i];
          const nodeName = rootMotionNodeName(tr.name);
          if (!ROOT_MOTION_TRACK_RE.test(nodeName) || !tr.values) continue;
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (let v = 0; v + 2 < tr.values.length; v += 3) {
            const x = tr.values[v], z = tr.values[v + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          }
          const disp = (maxX - minX) + (maxZ - minZ);
          if (disp > maxDisp) { maxDisp = disp; worst = tr; }
        }
        if (worst && maxDisp > 1) clip.tracks = clip.tracks.filter(t => t !== worst);
        clip._rootStripped = true;
        return clip;
      }
      function makeFbxActions(model, clips, names) {
        const mixer = clips.length ? new THREE.AnimationMixer(model) : null;
        const actions = {};
        if (!mixer) return { mixer, actions };
        Object.keys(names).forEach(key => {
          const clip = fbxClip(clips, names[key]);
          if (clip) actions[key] = mixer.clipAction(stripRootMotion(clip));
        });
        return { mixer, actions };
      }
      function playAnimalAction(animal, name, fade = 0.25) {
        if (!animal.actions || !animal.actions[name] || animal.currentAction === name) return;
        const next = animal.actions[name];
        const prev = animal.currentAction && animal.actions[animal.currentAction];
        if (prev === next) {
          // Walk and gallop can intentionally share the same stable clip. In that
          // case switching state labels must not reset the loop mid-stride.
          animal.currentAction = name;
          next.enabled = true;
          next.play();
          return;
        }
        next.enabled = true;
        next.reset();
        next.play();
        if (prev) prev.crossFadeTo(next, fade, false);
        animal.currentAction = name;
      }
      const terrainNormalTmp = new THREE.Vector3();
      const terrainForwardTmp = new THREE.Vector3();
      const terrainRightTmp = new THREE.Vector3();
      const terrainMatrixTmp = new THREE.Matrix4();
      const terrainQuatTmp = new THREE.Quaternion();
      const _animUp = new THREE.Vector3(0, 1, 0);
      function animalMotionEase(dt, sharpness) {
        return 1 - Math.exp(-Math.max(0, sharpness) * Math.max(0, dt));
      }
      function lerpAnimalAngle(a, b, t) {
        let d = (b - a + Math.PI) % (Math.PI * 2);
        if (d < 0) d += Math.PI * 2;
        return a + (d - Math.PI) * Math.max(0, Math.min(1, t));
      }
      function terrainNormalAt(x, z, step = 2.2) {
        const hL = heightAt(x - step, z), hR = heightAt(x + step, z);
        const hD = heightAt(x, z - step), hU = heightAt(x, z + step);
        return terrainNormalTmp.set(hL - hR, step * 2, hD - hU).normalize();
      }
      function orientGroundAnimal(animal, heading, yOffset = 0, smooth = 0.35, dt = 1 / 60) {
        const g = animal.g || animal;
        // Sample 5 points along the body axis (±1 and ±2 units) and average them.
        // This acts as a spatial box-filter: the finest terrain ridge octave (λ≈5u) is
        // attenuated to ~23% amplitude while large-scale slopes pass through unchanged.
        // The previous 3-point sample at ±1.8 only gave ~34% attenuation, leaving
        // visible Y-bouncing when galloping across bumpy terrain at full speed.
        const fx = Math.sin(heading), fz = Math.cos(heading);
        const ground = Math.max((
          heightAt(g.position.x - fx * 2, g.position.z - fz * 2) +
          heightAt(g.position.x - fx,     g.position.z - fz    ) +
          heightAt(g.position.x,           g.position.z          ) +
          heightAt(g.position.x + fx,     g.position.z + fz    ) +
          heightAt(g.position.x + fx * 2, g.position.z + fz * 2)
        ) * 0.2, WATER);
        const targetY = ground + yOffset;
        if (!Number.isFinite(animal.groundY) || smooth >= 1) {
          animal.groundY = targetY;
        } else {
          animal.groundY += (targetY - animal.groundY) * animalMotionEase(dt, 9);
          animal.groundY = Math.max(targetY - 0.45, Math.min(targetY + 0.45, animal.groundY));
        }
        g.position.y = animal.groundY;
        // Conform to the slope so the legs meet the ground; blend a touch toward world
        // up and slerp below for stability (so lake-edge normal jumps don't snap).
        const up = terrainNormalAt(g.position.x, g.position.z);
        up.lerp(_animUp, 0.2).normalize();
        const forward = terrainForwardTmp.set(Math.sin(heading), 0, Math.cos(heading));
        forward.addScaledVector(up, -forward.dot(up));
        if (forward.lengthSq() < 0.0001) forward.set(0, 0, 1);
        forward.normalize();
        const right = terrainRightTmp.crossVectors(up, forward).normalize();
        forward.crossVectors(right, up).normalize();
        terrainMatrixTmp.makeBasis(right, up, forward);
        terrainQuatTmp.setFromRotationMatrix(terrainMatrixTmp);
        if (smooth >= 1) g.quaternion.copy(terrainQuatTmp);
        else g.quaternion.slerp(terrainQuatTmp, Math.max(0.01, Math.min(1, smooth)));
      }
      const groundAnimalClipMap = {
        idle: [/^Idle$/i, /AnimalArmature\|Idle$/i, /Idle_2/i, /idle/i],
        idle2: [/Idle_2/i, /^Idle$/i, /idle/i],
        headlow: [/Idle_Headlow/i, /Headlow/i, /Eating/i, /idle/i],
        eating: [/Eating/i, /Idle_Headlow/i, /idle/i],
        walk: [/^Walk$/i, /AnimalArmature\|Walk/i, /walk/i],
        // The shipped Gallop clips drive IK/foot-control bones that Three.js does
        // not solve as constraints, which makes small hoof clusters flicker or lag
        // behind the legs. Use the stable walk cycle at a higher playback rate for
        // fleeing animals instead.
        gallop: [/^Walk$/i, /AnimalArmature\|Walk/i, /walk/i, /Gallop$/i],
        jump: [/Jump_toIdle/i, /Gallop_Jump/i, /Idle/i]
      };
      const _fbxCache = {};
      function clearGround(kind) {
        for (let i = groundAnimals.length - 1; i >= 0; i--) {
          if (groundAnimals[i].kind === kind) { scene.remove(groundAnimals[i].g); groundAnimals.splice(i, 1); }
        }
      }
      function spawnGroundAnimalPack(cfg) {
        clearGround(cfg.kind);
        const n = wcount(cfg.kind);
        if (n <= 0) return;
        const cached = _fbxCache[cfg.file];
        if (cached) { _spawnGroundInstances(cfg, n, cached); return; }
        if (!THREE.FBXLoader) return;
        new THREE.FBXLoader().load('models/' + cfg.file, fbx => {
          const clips = fbx.animations || [];
          fbx.traverse(o => {
            if (!o.isMesh) return;
            o.castShadow = true;
            o.receiveShadow = true;
            o.frustumCulled = false;
            // Skinned FBX exports from these animal packs often ship with un-normalized
            // skin weights (per-vertex weights that don't sum to 1). On certain animation
            // poses that over-weights a single bone and flings a vertex to a far coordinate,
            // producing the giant black "spike" triangles. Normalizing fixes it at the root.
            if (o.isSkinnedMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.skinWeight) {
              o.normalizeSkinWeights();
            }
            if (o.material) {
              const mats = Array.isArray(o.material) ? o.material : [o.material];
              mats.forEach(m => {
                if ('roughness' in m) m.roughness = Math.max(0.85, m.roughness || 0.85);
                m.side = THREE.DoubleSide; // prevent triangle shimmer when bone-deformed faces briefly flip toward camera
                m.needsUpdate = true;
              });
            }
          });
          const box = new THREE.Box3().setFromObject(fbx);
          const entry = { fbx, clips, box };
          _fbxCache[cfg.file] = entry;
          const want = wcount(cfg.kind); // re-read in case it changed during load
          if (want > 0) _spawnGroundInstances(cfg, want, entry);
        }, undefined, err => console.warn('Could not load ' + cfg.file, err));
      }
      function _spawnGroundInstances(cfg, n, entry) {
        const fbx = entry.fbx, clips = entry.clips, box = entry.box;
        const size = box.getSize(new THREE.Vector3());
        const baseScale = cfg.targetSize / Math.max(size.x || 1, size.y || 1, size.z || 1);
        const cloneModel = () => THREE.SkeletonUtils && THREE.SkeletonUtils.clone ? THREE.SkeletonUtils.clone(fbx) : fbx.clone(true);
        for (let i = 0; i < n; i++) {
          let x = 0, z = 0, h = WATER + 2;
          for (let tr = 0; tr < 60; tr++) {
            x = (rnd() - 0.5) * WORLD * (cfg.spread || 0.72);
            z = (rnd() - 0.5) * WORLD * (cfg.spread || 0.72);
            h = heightAt(x, z);
            if (h > WATER + (cfg.minGround || 1.4)) break;
          }
          const g = new THREE.Group();
          const model = cloneModel();
          const scale = baseScale * ((cfg.scaleMin || 0.9) + rnd() * (cfg.scaleJitter || 0.18));
          const modelBaseY = -box.min.y * scale;
          model.scale.setScalar(scale);
          model.position.y = modelBaseY;
          g.add(model);
          g.position.set(x, h, z);
          scene.add(g);
          const anim = makeFbxActions(model, clips, groundAnimalClipMap);
          Object.keys(anim.actions).forEach(k => { anim.actions[k].timeScale = 0.85 + rnd() * 0.25; });
          const initialAng = rnd() * 6.28;
          const animal = {
            kind: cfg.kind,
            g, model, modelBaseY, mixer: anim.mixer, actions: anim.actions, currentAction: '',
            sp: cfg.walkSpeed + rnd() * (cfg.walkJitter || 1.0),
            runSp: cfg.runSpeed + rnd() * (cfg.runJitter || 1.8),
            fleeDist: cfg.fleeDist || 22,
            ang: initialAng,
            targetAng: initialAng,
            t: rnd() * 9,
            dir: 1 + rnd() * 3,
            state: 'idle',
            stateT: 1 + rnd() * 4,
            idlePick: rnd(),
            spd: 0,
            moveSpd: 0,
            groundY: h,
            simAcc: rnd() * 0.25,
            animAcc: rnd() * 0.25
          };
          cacheAnimalShadowMeshes(animal);
          playAnimalAction(animal, animal.idlePick < 0.34 && anim.actions.eating ? 'eating' : (animal.idlePick < 0.67 && anim.actions.headlow ? 'headlow' : 'idle'), 0);
          if (animal.mixer) animal.mixer.setTime(rnd() * 2);
          orientGroundAnimal(animal, animal.ang, 0, 1);
          groundAnimals.push(animal);
        }
      }
      const GROUND_CFGS = [
        { file: 'Horse.fbx', kind: 'horse', targetSize: 5.4, walkSpeed: 2.4, walkJitter: 1.0, runSpeed: 8.6, runJitter: 1.9, fleeDist: 24 },
        { file: 'Deer.fbx', kind: 'deer', targetSize: 4.1, walkSpeed: 2.1, runSpeed: 7.8, fleeDist: 22 }
      ];
      function applyWildlife() {
        saveWildlifeCounts();
        if (spawnBirds) spawnBirds();
        if (spawnRabbits) spawnRabbits();
        if (spawnParrots) spawnParrots();
        GROUND_CFGS.forEach(spawnGroundAnimalPack);
      }
      // Respawn just one species (used for live edits from the UI).
      function applyWildlifeKey(key) {
        saveWildlifeCounts();
        if (key === 'bird') { if (spawnBirds) spawnBirds(); }
        else if (key === 'rabbit') { if (spawnRabbits) spawnRabbits(); }
        else if (key === 'parrot') { if (spawnParrots) spawnParrots(); }
        else { const cfg = GROUND_CFGS.find(c => c.kind === key); if (cfg) spawnGroundAnimalPack(cfg); }
      }
      function buildWildlifeUI() {
        const host = document.getElementById('wildlifeList');
        if (!host) return;
        host.innerHTML = '';
        WILDLIFE_DEFS.forEach(w => {
          const c = wildlifeCounts[w.key];
          const cell = document.createElement('div');
          cell.className = 'wildCell';
          const lbl = document.createElement('label');
          lbl.title = w.desc;
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.checked = c.on;
          lbl.appendChild(cb);
          lbl.appendChild(document.createTextNode(' ' + w.label));
          const nb = document.createElement('input');
          nb.type = 'number'; nb.min = '0'; nb.max = '200'; nb.value = c.n; nb.title = 'How many to spawn';
          const apply = () => {
            wildlifeCounts[w.key] = { on: cb.checked, n: Math.max(0, Math.min(200, parseInt(nb.value, 10) || 0)) };
            applyWildlifeKey(w.key);
          };
          const step = d => { nb.value = Math.max(0, Math.min(200, (parseInt(nb.value, 10) || 0) + d)); apply(); };
          const spin = document.createElement('div');
          spin.className = 'spin';
          const up = document.createElement('button'); up.type = 'button'; up.textContent = '▲'; up.tabIndex = -1; up.addEventListener('click', () => step(1));
          const down = document.createElement('button'); down.type = 'button'; down.textContent = '▼'; down.tabIndex = -1; down.addEventListener('click', () => step(-1));
          spin.appendChild(up); spin.appendChild(down);
          const numWrap = document.createElement('div');
          numWrap.className = 'numWrap';
          numWrap.appendChild(nb); numWrap.appendChild(spin);
          cb.addEventListener('change', apply);
          nb.addEventListener('change', apply);
          cell.appendChild(lbl);
          cell.appendChild(numWrap);
          host.appendChild(cell);
        });
      }
      buildWildlifeUI();
      applyWildlife();
      const WILDLIFE_NEAR2 = 85 * 85;
      const WILDLIFE_MID2 = 155 * 155;
      const WILDLIFE_HIDE2 = 260 * 260;
      const WILDLIFE_WIDE_HIDE2 = 360 * 360;
      const WILDLIFE_SHADOW2 = 95 * 95;
      const wildlifeFocus = new THREE.Vector3();
      function getWildlifeFocus() {
        if (inMainMenu) camera.getWorldPosition(wildlifeFocus);
        else if (mode === 'god') wildlifeFocus.copy(godTarget);
        else wildlifeFocus.copy(player.position);
        return wildlifeFocus;
      }
      function cacheAnimalShadowMeshes(animal) {
        animal.shadowMeshes = [];
        animal.model.traverse(o => { if (o.isMesh) animal.shadowMeshes.push(o); });
        animal.shadowOn = true;
        animal.shadowReceive = true;
      }
      function setAnimalShadowing(animal, enabled) {
        if (animal.shadowOn === enabled) return;
        animal.shadowOn = enabled;
        const meshes = animal.shadowMeshes || [];
        for (let i = 0; i < meshes.length; i++) {
          meshes[i].castShadow = enabled;
          meshes[i].receiveShadow = enabled && animal.shadowReceive !== false;
        }
      }
      function updateAnimalMixerBudgeted(animal, dt, interval, rate) {
        if (!animal.mixer || !animal.g.visible) return;
        animal.animAcc = (animal.animAcc || 0) + dt;
        if (interval <= 0 || animal.animAcc >= interval) {
          const animDt = Math.min(animal.animAcc, 0.25);
          animal.animAcc = 0;
          animal.mixer.update(animDt * rate);
        }
      }
      const animalThreatTmp = { found: false, dx: 0, dz: 0, dist: Infinity };
      function nearestEnemyThreat(x, z, range) {
        let found = false, best = range, dx = 0, dz = 0;
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          const ex = x - e.position.x, ez = z - e.position.z;
          const d = Math.hypot(ex, ez);
          if (d < best) { found = true; best = d; dx = ex; dz = ez; }
        }
        animalThreatTmp.found = found;
        animalThreatTmp.dx = dx;
        animalThreatTmp.dz = dz;
        animalThreatTmp.dist = best;
        return animalThreatTmp;
      }
      function updateWildlife(dt, t) {
        const focus = getWildlifeFocus();
        const hideDist2 = (inMainMenu || mode === 'god') ? WILDLIFE_WIDE_HIDE2 : WILDLIFE_HIDE2;
        for (let i = 0; i < birds.length; i++) {
          const b = birds[i]; b.ang += b.sp * dt;
          b.g.position.set(b.cx + Math.cos(b.ang) * b.r, b.hgt + Math.sin(t * 0.5 + b.fph) * 4, b.cz + Math.sin(b.ang) * b.r);
          b.g.rotation.y = -b.ang; const f = Math.sin(t * b.flap + b.fph) * 0.7; b.wl.rotation.z = f; b.wr.rotation.z = -f;
        }
        for (let i = 0; i < parrots.length; i++) {
          const p = parrots[i];
          if (p === controlledParrot) { p.g.visible = true; updateAnimalMixerBudgeted(p, dt, 0, 1); continue; }
          p.ang += p.sp * dt;
          const x = p.cx + Math.cos(p.ang) * p.r + Math.sin(t * 0.17 + p.phase) * p.driftX;
          const z = p.cz + Math.sin(p.ang) * p.r + Math.cos(t * 0.13 + p.phase) * p.driftZ;
          const y = Math.max(heightAt(x, z) + 16, p.hgt + Math.sin(t * 0.8 + p.phase) * 5);
          const nx = p.cx + Math.cos(p.ang + 0.02) * p.r + Math.sin(t * 0.17 + p.phase) * p.driftX;
          const nz = p.cz + Math.sin(p.ang + 0.02) * p.r + Math.cos(t * 0.13 + p.phase) * p.driftZ;
          p.g.position.set(x, y, z);
          const pdx = x - focus.x, pdz = z - focus.z, pd2 = pdx * pdx + pdz * pdz;
          p.g.visible = pd2 < hideDist2;
          setAnimalShadowing(p, p.g.visible && pd2 < WILDLIFE_SHADOW2);
          if (!p.g.visible) { p.animAcc = 0; continue; }
          p.g.rotation.set(Math.sin(t * 0.65 + p.phase) * 0.08, Math.atan2(nx - x, nz - z), Math.sin(t * 0.9 + p.phase) * 0.14);
          updateAnimalMixerBudgeted(p, dt, 0, 1);   // animate every frame -> smooth wings
        }
        for (let i = 0; i < groundAnimals.length; i++) {
          const s = groundAnimals[i];
          const fdx = s.g.position.x - focus.x, fdz = s.g.position.z - focus.z, fd2 = fdx * fdx + fdz * fdz;
          s.g.visible = fd2 < hideDist2;
          setAnimalShadowing(s, s.g.visible && fd2 < WILDLIFE_SHADOW2);
          if (!s.g.visible) { s.simAcc = 0; s.animAcc = 0; continue; }
          // Always animate every frame while visible. Budgeting the mixer by distance
          // updated the legs at only ~5-12fps, which read as a stuttering/"choppy"
          // gait. A handful of skinned animals per frame is cheap; the player model
          // animates every frame too, which is why it looks smooth.
          const animInterval = 0;
          // Timers advance every frame so distant animals stay in real time.
          s.t += dt; s.dir -= dt; s.stateT -= dt;
          // Decision logic (threat scan + state machine) is the expensive part, so it
          // stays budgeted by distance. It only sets intent (state / heading / speed);
          // the actual motion below runs every frame so it never teleports or jitters.
          const simInterval = fd2 < WILDLIFE_NEAR2 ? 0 : (fd2 < WILDLIFE_MID2 ? 0.12 : 0.35);
          s.simAcc = (s.simAcc || 0) + dt;
          if (simInterval <= 0 || s.simAcc >= simInterval) {
            s.simAcc = 0;
            const threat = nearestEnemyThreat(s.g.position.x, s.g.position.z, s.fleeDist);
            if (threat.found) {
              s.state = 'gallop';
              s.stateT = 1.2;
              s.targetAng = Math.atan2(threat.dx, threat.dz);
              s.spd = Math.min(s.runSp, s.sp * 2.15);
              playAnimalAction(s, 'gallop');
            } else {
              if (s.stateT <= 0) {
                const r = rnd();
                if (r < 0.25) { s.state = 'eating'; s.stateT = 2.5 + rnd() * 4.5; }
                else if (r < 0.48) { s.state = 'headlow'; s.stateT = 2 + rnd() * 3; }
                else if (r < 0.7) { s.state = 'idle'; s.stateT = 1.5 + rnd() * 3.5; }
                else { s.state = 'walk'; s.stateT = 2 + rnd() * 5; s.dir = s.stateT; s.targetAng = s.ang + (rnd() - 0.5) * 1.6; }
              }
              if (s.state === 'gallop') {
                s.spd = Math.min(s.runSp, s.sp * 2.15);
                playAnimalAction(s, 'gallop');
              } else if (s.state === 'walk') {
                s.spd = s.sp;
                playAnimalAction(s, 'walk');
              } else {
                s.spd = 0;
                const act = s.state === 'eating' && s.actions.eating ? 'eating' : (s.state === 'headlow' && s.actions.headlow ? 'headlow' : (s.state === 'idle' && s.actions.idle2 && s.idlePick > 0.5 ? 'idle2' : 'idle'));
                playAnimalAction(s, act);
              }
            }
          }
          // Motion + orientation every frame -> smooth at any distance.
          if (!Number.isFinite(s.targetAng)) s.targetAng = s.ang;
          s.ang = lerpAnimalAngle(s.ang, s.targetAng, animalMotionEase(dt, s.state === 'gallop' ? 7 : 4.5));
          const desiredSp = s.spd || 0;
          const curSp = s.moveSpd || 0;
          s.moveSpd = curSp + (desiredSp - curSp) * animalMotionEase(dt, desiredSp > curSp ? 4.5 : 7.5);
          if (desiredSp <= 0 && s.moveSpd < 0.03) s.moveSpd = 0;
          const sp = s.moveSpd || 0;
          if (sp > 0) {
            const nx = s.g.position.x + Math.sin(s.ang) * sp * dt;
            const nz = s.g.position.z + Math.cos(s.ang) * sp * dt;
            if (heightAt(nx, nz) > WATER + 0.6) {
              s.g.position.x = nx; s.g.position.z = nz;
            } else {
              // Would step into water: steer toward higher ground (inland) and keep
              // walking, so it calmly leaves the shore instead of jittering at the edge.
              const gx = heightAt(s.g.position.x + 2, s.g.position.z) - heightAt(s.g.position.x - 2, s.g.position.z);
              const gz = heightAt(s.g.position.x, s.g.position.z + 2) - heightAt(s.g.position.x, s.g.position.z - 2);
              if (gx * gx + gz * gz > 1e-6) s.targetAng = Math.atan2(gx, gz);
              else s.targetAng = s.ang + Math.PI;
              s.state = 'walk'; s.spd = s.sp;
              if (s.stateT < 0.5) s.stateT = 1.5 + rnd() * 2;
              playAnimalAction(s, 'walk');
            }
          }
          const lim = WORLD * 0.5 - 5;
          if (s.g.position.x < -lim || s.g.position.x > lim || s.g.position.z < -lim || s.g.position.z > lim) {
            s.targetAng = s.ang + Math.PI;
            s.g.position.x = Math.max(-lim, Math.min(lim, s.g.position.x));
            s.g.position.z = Math.max(-lim, Math.min(lim, s.g.position.z));
          }
          orientGroundAnimal(s, s.ang, 0, fd2 < WILDLIFE_NEAR2 ? 0.2 : 0.35, dt);
          const gaitAmt = Math.min(1, sp / Math.max(0.01, s.sp));
          s.model.position.y = s.modelBaseY + (sp > 0.03 ? Math.sin(s.t * 6) * 0.022 * gaitAmt : 0);
          const speedRate = Math.max(0.75, Math.min(1.65, sp / Math.max(0.1, s.sp)));
          updateAnimalMixerBudgeted(s, dt, animInterval, s.state === 'gallop' ? Math.max(1.2, speedRate) : s.state === 'walk' ? Math.min(1.15, speedRate) : 0.85);
        }
        for (let i = 0; i < critters.length; i++) {
          const c = critters[i]; c.t += dt; c.dir -= dt;
          const threat = nearestEnemyThreat(c.g.position.x, c.g.position.z, 11);
          let sp = c.sp;
          if (threat.found) { c.ang = Math.atan2(threat.dx, threat.dz); sp = c.sp * 2.2; }
          else if (c.dir <= 0) { c.ang += (Math.random() - 0.5) * 2.0; c.dir = 2 + Math.random() * 4; }
          const nx = c.g.position.x + Math.sin(c.ang) * sp * dt, nz = c.g.position.z + Math.cos(c.ang) * sp * dt;
          if (heightAt(nx, nz) > WATER + 0.3) { c.g.position.x = nx; c.g.position.z = nz; } else c.ang += Math.PI;
          const lim = WORLD * 0.5 - 4; c.g.position.x = Math.max(-lim, Math.min(lim, c.g.position.x)); c.g.position.z = Math.max(-lim, Math.min(lim, c.g.position.z));
          orientGroundAnimal(c, c.ang, 0, 0.4, dt);
          if (c.type === 'rabbit') { c.hop += dt * (6 + sp); c.g.position.y += Math.max(0, Math.sin(c.hop)) * 0.4; }
          else { const g2 = Math.sin(c.t * 5) * 0.5; for (let l = 0; l < c.legs.length; l++) c.legs[l].rotation.x = (l % 2 ? g2 : -g2); }
        }
      }
      function attack() {
        if (mode !== 'fps' || !locked) return;
        attackAnim = (attackAnim === 'punch') ? 'kick' : 'punch';
        swingT = 0.28;
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        for (let i = enemies.length - 1; i >= 0; i--) {
          const e = enemies[i], dx = e.position.x - player.position.x, dz = e.position.z - player.position.z, d = Math.hypot(dx, dz) || 1;
          if (d < 4.2 && (dx * fx + dz * fz) / d > 0.35) {
            e.userData.hp -= playerDmg; sfxHit();
            if (e.userData.hp <= 0) { scene.remove(e); enemies.splice(i, 1); kills++; const k = document.getElementById('kills'); if (k) k.textContent = kills; sfxCollect(); }
          }
        }
      }
      function sfxHit() { if (!_actx) return; const t0 = _actx.currentTime, o = _actx.createOscillator(); o.type = 'square'; o.frequency.setValueAtTime(180, t0); o.frequency.exponentialRampToValueAtTime(60, t0 + 0.12); const g = _actx.createGain(); o.connect(g); g.connect(_sfxGain); g.gain.setValueAtTime(0.18, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14); o.start(t0); o.stop(t0 + 0.16); }
      function updateEnemies(dt, t) {
        for (let i = enemies.length - 1; i >= 0; i--) {
          const e = enemies[i], u = e.userData; u.t += dt; u.cd -= dt; u.dir -= dt;
          const dx = player.position.x - e.position.x, dz = player.position.z - e.position.z, dist = Math.hypot(dx, dz);
          if (mode === 'fps' && !parrotMode && dist < 13) { u.ang = Math.atan2(dx, dz); } else if (u.dir <= 0) { u.ang += (Math.random() - 0.5) * 2.5; u.dir = 2 + Math.random() * 3; }
          const sp = 2.4 * dt; const nx = e.position.x + Math.sin(u.ang) * sp, nz = e.position.z + Math.cos(u.ang) * sp;
          if (heightAt(nx, nz) > WATER) { e.position.x = nx; e.position.z = nz; } else { u.ang += Math.PI; }
          const lim = WORLD * 0.5 - 4; e.position.x = Math.max(-lim, Math.min(lim, e.position.x)); e.position.z = Math.max(-lim, Math.min(lim, e.position.z));
          e.position.y = Math.max(heightAt(e.position.x, e.position.z), WATER); e.rotation.y = u.ang;
          u.body.position.y = 0.45 + Math.abs(Math.sin(u.t * 5)) * 0.3; // hop
          if (mode === 'fps' && !parrotMode && dist < 1.7 && u.cd <= 0) { hurtPlayer(11); u.cd = 1.0; }
          if (mode === 'fps' && !parrotMode && dist < 1.05 && dist > 1e-4) { const k = (1.05 - dist) / dist; player.position.x += dx * k; player.position.z += dz * k; } // can't walk through a slime
        }
      }
      normalizeShadowCastingMaterials(scene);

      /* ============================================================
         LOOP
         ============================================================ */
      const clock = new THREE.Clock();
      let fpsT = 0, fpsN = 0;
      const tmpV = new THREE.Vector3();
      const _uw = document.getElementById('underwater'), _br = document.getElementById('breath'), _brf = document.getElementById('breathFill');

      /* ---- Main-menu hero parrot: a single bird the camera chases on a
         cinematic flight path around the island while the menu is up. ---- */
      let menuParrot = null, menuParrotMixer = null, menuParrotAction = null, _menuParrotReq = false;
      const mpPos = new THREE.Vector3(), mpVelV = new THREE.Vector3();
      const _mpTarget = new THREE.Vector3(), _mpDir = new THREE.Vector3(), _mpPerch = new THREE.Vector3();
      const _mpFwd = new THREE.Vector3(0, 0, 1), _mpTmp = new THREE.Vector3();
      const _camTarget = new THREE.Vector3(), _lookTarget = new THREE.Vector3(), _mpRight = new THREE.Vector3();
      const _mpRay = new THREE.Raycaster(), _mpLOS = new THREE.Vector3();
      // flight state machine: cruise -> glide down to a perch -> sit -> cruise
      let mpPhase = Math.random() * 100;   // path parameter (advances while cruising)
      let mpState = 'fly', mpStateT = 0, mpHold = 0, mpNextPerch = 9 + Math.random() * 7;
      let mpYaw = 0, mpPitch = 0, mpRoll = 0, mpInit = false;
      const MP_CRUISE = 11, MP_PATHRATE = 0.11;   // units/s and path speed
      function menuParrotPos(a, out) {
        // wandering loop: radius and height swell and shrink for an organic orbit
        const R = 96 + 34 * Math.sin(a * 0.6) + 8 * Math.sin(a * 1.7 + 1.3);
        const x = Math.sin(a) * R, z = Math.cos(a) * R;
        const y = 44 + 15 * Math.sin(a * 0.9 + 0.4) + 4 * Math.sin(a * 2.3);
        out.set(x, Math.max(heightAt(x, z) + 18, y), z);
        return out;
      }
      // The path phase whose point is nearest a perch, so the bird rejoins the
      // loop at the closest spot instead of racing back across the island.
      function nearestPathPhase(p) {
        let best = mpPhase, bestD = Infinity;
        for (let i = 0; i < 48; i++) {
          const ph = mpPhase + (i / 48) * Math.PI * 2;
          menuParrotPos(ph, _mpTmp);
          const dx = _mpTmp.x - p.x, dz = _mpTmp.z - p.z, d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = ph; }
        }
        return best;
      }
      // Choose the nearest real, exposed landing spot (roof ridge / fence post) to
      // the bird, but only if it's reasonably close so the glide-down stays short.
      // Using a curated list means it never tries to land in water or inside foliage.
      function pickPerch(near, out) {
        let best = null, bestD = Infinity;
        for (let i = 0; i < perchSpots.length; i++) {
          const p = perchSpots[i];
          const dx = p.x - near.x, dz = p.z - near.z, d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = p; }
        }
        if (best && bestD < 60 * 60) { out.set(best.x, best.y, best.z); return true; }
        return false;
      }
      function ensureMenuParrot() {
        if (menuParrot || _menuParrotReq || !THREE.GLTFLoader) return;
        const build = gltf => {
          const clip = gltf.animations && gltf.animations[0];
          const g = new THREE.Group();
          const model = gltf.scene.clone(true);
          model.scale.setScalar(0.055);                      // realistic next to props; camera sits close
          model.traverse(o => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; o.receiveShadow = false; } });
          g.add(model); g.frustumCulled = false; scene.add(g);
          menuParrotMixer = clip ? new THREE.AnimationMixer(model) : null;
          if (menuParrotMixer) { menuParrotAction = menuParrotMixer.clipAction(clip); menuParrotAction.timeScale = 1.15; menuParrotAction.play(); }
          menuParrot = g; mpInit = false; mpState = 'fly'; mpStateT = 0; mpVelV.set(0, 0, 0); mpNextPerch = 9 + Math.random() * 7;
        };
        if (_parrotGltf) { build(_parrotGltf); return; }
        _menuParrotReq = true;
        new THREE.GLTFLoader().load('models/Flying_Parrot_Animated.glb', gltf => {
          gltf.scene.traverse(o => { if (o.isMesh && o.material) { const mats = Array.isArray(o.material) ? o.material : [o.material]; mats.forEach(m => { m.roughness = Math.max(0.55, m.roughness || 0.55); m.needsUpdate = true; }); } });
          _parrotGltf = gltf; _menuParrotReq = false; if (inMainMenu) build(gltf);
        }, undefined, err => { _menuParrotReq = false; console.warn('Could not load menu parrot', err); });
      }
      function updateMenuParrotCamera(t, dt) {
        if (!menuParrot) {
          // graceful fallback orbit until the model finishes loading
          const orbitAngle = t * 0.045, R = 130;
          const cx = Math.sin(orbitAngle) * R, cz = Math.cos(orbitAngle) * R;
          camera.position.set(cx, Math.max(32, heightAt(cx, cz) + 36), cz);
          camera.lookAt(0, 4, 0);
          return;
        }
        menuParrot.visible = true;
        if (!mpInit) { menuParrotPos(mpPhase, mpPos); mpVelV.set(0, 0, 0); mpInit = true; }
        mpStateT += dt;

        // --- choose a steering target + desired speed for the current state ---
        let flapping = true, desiredSpeed = MP_CRUISE;
        if (mpState === 'fly') {
          mpPhase += dt * MP_PATHRATE;
          menuParrotPos(mpPhase, _mpTarget);
          mpNextPerch -= dt;
          if (mpNextPerch <= 0) {
            if (pickPerch(mpPos, _mpPerch)) { mpState = 'toperch'; mpStateT = 0; }
            else mpNextPerch = 3 + Math.random() * 3;
          }
        } else if (mpState === 'toperch') {
          _mpTarget.copy(_mpPerch);
          const dist = mpPos.distanceTo(_mpPerch);
          desiredSpeed = MP_CRUISE * Math.max(0.2, Math.min(1, dist / 14));   // ease to a gentle stop
          if (dist < 1.2) { mpState = 'perched'; mpStateT = 0; mpHold = 2 + Math.random(); mpPos.copy(_mpPerch); mpVelV.set(0, 0, 0); }
          else if (mpStateT > 8) { mpState = 'fly'; mpStateT = 0; mpNextPerch = 6 + Math.random() * 6; }  // gave up — never get stuck
        } else { // perched
          _mpTarget.copy(_mpPerch); desiredSpeed = 0; flapping = false;
          if (mpStateT >= mpHold) { mpPhase = nearestPathPhase(_mpPerch); mpState = 'fly'; mpStateT = 0; mpNextPerch = 8 + Math.random() * 8; }
        }

        // --- velocity-integrated steering: constant cruise speed, smooth turns ---
        _mpDir.subVectors(_mpTarget, mpPos);
        const dd = _mpDir.length() || 1e-3;
        _mpDir.multiplyScalar(desiredSpeed / dd);             // desired velocity vector
        mpVelV.lerp(_mpDir, 1 - Math.pow(0.04, dt));          // smooth acceleration / banking
        const sp = mpVelV.length();
        if (sp > MP_CRUISE * 1.3) mpVelV.multiplyScalar(MP_CRUISE * 1.3 / sp);
        mpPos.addScaledVector(mpVelV, dt);
        // Keep clear of the ground only while cruising; landing must be free to
        // descend onto low perches (fence posts sit just ~1.5 above the ground).
        if (mpState === 'fly') { const minY = heightAt(mpPos.x, mpPos.z) + 3; if (mpPos.y < minY) mpPos.y = minY; }

        // --- orientation from the (already smooth) velocity ---
        const horiz = Math.hypot(mpVelV.x, mpVelV.z);
        let targetPitch = 0, targetRoll = 0;
        if (horiz > 0.06) {
          const yaw = Math.atan2(mpVelV.x, mpVelV.z);
          let dyaw = yaw - mpYaw; while (dyaw > Math.PI) dyaw -= 2 * Math.PI; while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
          mpYaw = yaw;
          targetRoll = Math.max(-0.6, Math.min(0.6, -(dyaw / dt) * 0.22));
          targetPitch = Math.max(-0.45, Math.min(0.45, Math.atan2(mpVelV.y, horiz) * 0.6));
        }
        const ease = 1 - Math.pow(0.025, dt);
        mpRoll += (targetRoll - mpRoll) * ease;
        mpPitch += (targetPitch - mpPitch) * ease;
        menuParrot.position.copy(mpPos);
        menuParrot.rotation.set(-mpPitch, mpYaw, mpRoll, 'YXZ');

        // --- close chase camera, slightly to the side for a flattering 3/4 view ---
        if (horiz > 0.06) { _mpTmp.set(mpVelV.x, 0, mpVelV.z).normalize(); _mpFwd.lerp(_mpTmp, 1 - Math.pow(0.08, dt)); }
        if (_mpFwd.lengthSq() < 1e-6) _mpFwd.set(0, 0, 1);
        _mpTmp.copy(_mpFwd).normalize();
        _mpRight.set(_mpTmp.z, 0, -_mpTmp.x);                 // horizontal right of travel
        // Near a perch the bird is low on a roof/fence, so lift the camera and look
        // down at it — this keeps it clear of the very thing it's sitting on.
        let perchBlend = 0;
        if (mpState === 'perched') perchBlend = 1;
        else if (mpState === 'toperch') perchBlend = Math.max(0, Math.min(1, 1 - mpPos.distanceTo(_mpPerch) / 16));
        const backDist = 3.3 - 0.7 * perchBlend, upH = 1.1 + 2.7 * perchBlend, side = 0.9 * (1 - 0.55 * perchBlend);
        _camTarget.copy(mpPos).addScaledVector(_mpTmp, -backDist).addScaledVector(_mpRight, side);
        _camTarget.y += upH;
        const groundY = heightAt(_camTarget.x, _camTarget.z) + 1.8;
        if (_camTarget.y < groundY) _camTarget.y = groundY;
        // Guarantee the bird stays visible: if a house roof/wall blocks the line of
        // sight (mostly when perched), lift the camera until it has a clear view.
        if (perchBlend > 0.01 && houseGroups.length) {
          for (let tries = 0; tries < 8; tries++) {
            _mpLOS.subVectors(mpPos, _camTarget);
            const segLen = _mpLOS.length(); if (segLen < 0.05) break;
            _mpLOS.multiplyScalar(1 / segLen);
            _mpRay.set(_camTarget, _mpLOS); _mpRay.far = segLen - 0.5;
            if (!_mpRay.intersectObjects(houseGroups, true).length) break;
            _camTarget.y += 1.6;
          }
        }
        camera.position.lerp(_camTarget, 1 - Math.pow(perchBlend > 0.4 ? 0.00008 : 0.0016, dt));
        _lookTarget.copy(mpPos).addScaledVector(_mpTmp, 0.6 * (1 - perchBlend)); _lookTarget.y += 0.25 - 0.2 * perchBlend;
        camera.lookAt(_lookTarget);

        if (menuParrotAction) menuParrotAction.timeScale = flapping ? 1.15 : 0.15;
        if (menuParrotMixer) menuParrotMixer.update(dt);
      }

      function animate() {
        requestAnimationFrame(animate);
        const dt = Math.min(clock.getDelta(), 0.05);
        const t = clock.elapsedTime;

        if (inMainMenu) {
          // Camera chases a hero parrot on a cinematic loop around the island
          ensureMenuParrot();
          updateMenuParrotCamera(t, dt);

          // Animate background elements
          waterFoamU.uTime.value = t;
          TEX.waterN.offset.x = t * 0.035; TEX.waterN.offset.y = t * 0.022;
          for (let i = 0; i < wN; i++) {
            const x = wbx[i], z = wbz[i];
            const a = x * 0.06 + t * 1.15, b = z * 0.05 - t * 0.95, c = (x + z) * 0.11 + t * 1.9;
            wpos.setY(i, 0.5 * Math.sin(a) + 0.42 * Math.sin(b) + 0.16 * Math.sin(c));
            const da = 0.5 * 0.06 * Math.cos(a), db = 0.42 * 0.05 * Math.cos(b), dc = 0.16 * 0.11 * Math.cos(c);
            const nx = -(da + dc), nz = -(db + dc), inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
            wnor.setXYZ(i, nx * inv, inv, nz * inv);
          }
          wpos.needsUpdate = true; wnor.needsUpdate = true;

          windUniforms.uTime.value = t;
          windUniforms.uWind.value = 0.16 + 0.14 * Math.sin(t * 0.3) + 0.07 * Math.sin(t * 0.13 + 1.0);
          const windSpd = 1.0 + windUniforms.uWind.value * 4;
          for (let i = 0; i < clouds.length; i++) { const c = clouds[i]; c.grp.position.x += c.spd * windSpd * dt; if (c.grp.position.x > WORLD * 0.62) c.grp.position.x = -WORLD * 0.62; }
          for (let i = 0; i < smoke.length; i++) { const sm = smoke[i]; const up = ((t * 0.7 + sm.phase) % 2.6); sm.mesh.position.y = sm.baseY + up; const k = 1 - up / 2.6; sm.mesh.scale.setScalar(0.45 + k * 0.85); }
          for (let i = 0; i < motes.N; i++) { let y = motes.pos[i * 3 + 1] + motes.spd[i] * dt; if (y > 40) y = 5; motes.pos[i * 3 + 1] = y; motes.pos[i * 3] += Math.sin(t * 0.4 + i) * 0.006; }
          motes.pts.geometry.attributes.position.needsUpdate = true;

          updateWildlife(dt, t);

          setShadowFocus(0, 0, 0, SHADOW_HALF_MENU);

          renderer.render(scene, camera);
          return;
        }

        // hero parrot only belongs to the menu — hide it once gameplay starts
        if (menuParrot && menuParrot.visible) menuParrot.visible = false;

        const transitionCamera = updateMenuCameraTransition();
        if (transitionCamera) {
          renderer.render(scene, transitionCamera);
          return;
        }

        if (paused) { renderer.render(scene, mode === 'god' ? godCam : camera); return; }   // menu open: freeze the world, keep showing it

        // god / builder camera takes over when active
        if (mode === 'god') updateGod(dt);

        // orientation
        player.rotation.y = yaw;

        /* ---- Parrot possession mode (F key) — airplane flight model ---- */
        if (parrotMode && controlledParrot) {
          // Forward = camera look direction. Rx(pitch)*Ry(yaw) on local -Z gives Y=+sin(pitch)
          const fwdX = -Math.sin(yaw) * Math.cos(pitch);
          const fwdY = Math.sin(pitch);
          const fwdZ = -Math.cos(yaw) * Math.cos(pitch);
          // W = accelerate in look direction, S = brake, no separate up/down keys
          const pSpd = (keys['ShiftLeft'] || keys['ShiftRight']) ? 28 : 16;
          let targetSpeed = 0;
          if (keys['KeyW']) targetSpeed = pSpd;
          else if (keys['KeyS']) targetSpeed = -pSpd * 0.35;
          parrotVel.x += (fwdX * targetSpeed - parrotVel.x) * Math.min(1, dt * 3.5);
          parrotVel.y += (fwdY * targetSpeed - parrotVel.y) * Math.min(1, dt * 3.0);
          parrotVel.z += (fwdZ * targetSpeed - parrotVel.z) * Math.min(1, dt * 3.5);
          const plim = WORLD * 0.5 - 4;
          controlledParrot.g.position.x = Math.max(-plim, Math.min(plim, controlledParrot.g.position.x + parrotVel.x * dt));
          controlledParrot.g.position.z = Math.max(-plim, Math.min(plim, controlledParrot.g.position.z + parrotVel.z * dt));
          const pmh = heightAt(controlledParrot.g.position.x, controlledParrot.g.position.z) + 2;
          controlledParrot.g.position.y = Math.max(pmh, controlledParrot.g.position.y + parrotVel.y * dt);
          if (controlledParrot.g.position.y <= pmh) parrotVel.y = 0;
          // Parrot body faces exactly where camera looks (Euler XYZ: θx=pitch, θy=π+yaw)
          controlledParrot.g.rotation.set(pitch, Math.PI + yaw, Math.sin(t * 0.9 + controlledParrot.phase) * 0.05);
          player.position.copy(controlledParrot.g.position);
          // Camera behind parrot, stays fixed relative to parrot facing
          const pcDist = 3;
          camera.position.set(0, 1.2 - pcDist * Math.sin(pitch), pcDist * Math.cos(pitch));
          camera.rotation.set(pitch, 0, 0);
          vy = 0; vel.set(0, 0, 0);
        }

        if (!parrotMode) {
          // input -> horizontal velocity (camera-relative on yaw plane)
          const sprint = keys['ShiftLeft'] || keys['ShiftRight'];
          const speed = (sprint ? 13 : 7);
          let ix = 0, iz = 0;
          if (mode === 'fps') { if (keys['KeyW']) iz -= 1; if (keys['KeyS']) iz += 1; if (keys['KeyA']) ix -= 1; if (keys['KeyD']) ix += 1; }
          const len = Math.hypot(ix, iz) || 1; ix /= len; iz /= len;
          const sin = Math.sin(yaw), cos = Math.cos(yaw);
          const wishX = (ix * cos + iz * sin), wishZ = (-ix * sin + iz * cos);
          const moving = (ix || iz) && onGround;
          vel.x += (wishX * speed - vel.x) * Math.min(1, dt * 12);
          vel.z += (wishZ * speed - vel.z) * Math.min(1, dt * 12);
          player.position.x += vel.x * dt;
          player.position.z += vel.z * dt;
          // bounds
          const lim = WORLD * 0.5 - 4;
          player.position.x = Math.max(-lim, Math.min(lim, player.position.x));
          player.position.z = Math.max(-lim, Math.min(lim, player.position.z));
          if (mode === 'fps') resolvePlayerCollision();   // block rocks, house walls, etc. (door gap stays open)
        }

        // terrain height at current x,z (used for gravity and water checks)
        const groundH = heightAt(player.position.x, player.position.z);

        if (!parrotMode) {
          // gravity + ground (+ swimming when you wade out into deep water)
          vy -= 24 * dt; player.position.y += vy * dt;
          const _hf = houseFloorAt(player.position.x, player.position.z);   // stand on the interior floor when inside a house
          const feet = _hf !== null ? _hf : groundH;
          const submerged = mode === 'fps' && (player.position.y + EYE) < WATER;
          if (submerged) { vy = Math.max(vy * 0.9, -2.6); if (keys['Space']) vy += 22 * dt; } // buoyant drag + swim up
          if (player.position.y <= feet) {
            player.position.y = feet; vy = 0; onGround = true;
          } else if (vy <= 0 && !submerged && (player.position.y - feet) < 1.0 && Math.hypot(vel.x, vel.z) > 0.3) {
            // Walking down a slope: the ground drops a little each frame. Stick to it
            // instead of briefly launching into the air (which caused the downhill
            // "slide + jitter"). Ascending was already fine because the ground rises
            // up to meet the player.
            player.position.y = feet; vy = 0; onGround = true;
          } else onGround = false;
          if (mode === 'fps' && !submerged && keys['Space'] && onGround) { vy = 9.2; onGround = false; sfxJump(); }
        }

        // head bob + gait driven by ACTUAL horizontal speed -> always animates while moving (even when gliding to a stop)
        const hsp = Math.hypot(vel.x, vel.z);
        const moveAmt = Math.min(1, hsp / 7);
        if (hsp > 0.4 && onGround) bob += dt * (7 + hsp * 1.1);
        // footstep SFX cadence
        if (hsp > 0.4 && onGround) { stepAcc += dt * (1.3 + hsp * 0.16); if (stepAcc >= 1) { stepAcc = 0; sfxStep(); } } else stepAcc = 0.75;
        const third = !parrotMode && mode === 'fps' && view === 'third';
        if (!parrotMode) {
          if (third) {   // orbit camera behind/above the visible character
            const tp = Math.max(-0.6, Math.min(1.0, pitch)), dist = 6.4, ty = 2.6;
            camera.position.set(0, ty - dist * Math.sin(tp), dist * Math.cos(tp));
            camera.rotation.set(tp, 0, 0);
          } else {
            camera.position.set(Math.cos(bob * 0.5) * 0.04 * moveAmt, EYE + Math.sin(bob) * 0.07 * moveAmt, 0);
            camera.rotation.set(pitch, 0, 0);
          }
        }

        // visible body follows player, yawed, with walking gait
        body.position.set(player.position.x, player.position.y, player.position.z);
        body.rotation.y = yaw;
        const sw = Math.sin(bob), m = moveAmt;
        if (!usingDwarf) {
          // ---- legacy box avatar gait ----
          // hips swing fore/aft; knees flex on the forward swing to clear the ground
          legLj.hip.rotation.x = sw * 0.85 * m;
          legRj.hip.rotation.x = -sw * 0.85 * m;
          legLj.knee.rotation.x = (0.12 + Math.max(0, -sw) * 1.15) * m;
          legRj.knee.rotation.x = (0.12 + Math.max(0, sw) * 1.15) * m;
          // arms swing opposite the legs, with a natural elbow bend
          armLj.sh.rotation.x = -sw * 0.6 * m;
          armRj.sh.rotation.x = sw * 0.6 * m;
          armLj.elbow.rotation.x = -(0.25 + Math.abs(sw) * 0.35) * m;
          armRj.elbow.rotation.x = -(0.25 + Math.abs(sw) * 0.35) * m;
          // attack swing on the right arm (visible in third-person)
          if (swingT > 0) { const k = Math.sin(Math.min(1, swingT / 0.28) * Math.PI); armRj.sh.rotation.x = -1.9 * k; armRj.sh.rotation.z = -0.3 * k; armRj.elbow.rotation.x = -1.1 * k; } else { armRj.sh.rotation.z = 0; }
          head.visible = third;
        } else if (playerMixer && !parrotMode) {
          // ---- animated dwarf: pick a clip from the movement state ----
          let act = 'idle';
          if (swingT > 0 && playerActions[attackAnim]) act = attackAnim;
          else if (!onGround && playerActions.jump) act = 'jump';
          else if (hsp > 8.5 && playerActions.run) act = 'run';
          else if (hsp > 0.5 && playerActions.walk) act = 'walk';
          setPlayerAction(act);
          playerMixer.update(dt);
        }
        // body visible in third-person only; vm hidden (torch removed)
        body.visible = third; vm.visible = false;

        // viewmodel arm sway/bob
        vmL.rotation.x = -0.5 + Math.sin(bob) * 0.18 * moveAmt;
        vmR.rotation.x = -0.5 + Math.sin(bob + Math.PI) * 0.18 * moveAmt;
        vm.position.y = Math.sin(bob * 2) * 0.02 * moveAmt;
        // torch swing on attack
        if (swingT > 0) { swingT -= dt; const k = Math.sin(Math.max(0, swingT) / 0.28 * Math.PI); vm.rotation.z = -k * 0.5; vm.rotation.x = k * 0.45; } else { vm.rotation.z = 0; vm.rotation.x = 0; }
        // torch flame flicker
        flame.scale.set(0.85 + Math.sin(t * 22) * 0.12, 0.8 + Math.sin(t * 17 + 1) * 0.18 + Math.random() * 0.08, 0.85 + Math.cos(t * 20) * 0.12);
        tlight.intensity = 1.5 + Math.sin(t * 26) * 0.4 + Math.random() * 0.15;

        // animated water: rolling swell + drifting ripple map (seamless) + shader foam
        waterFoamU.uTime.value = t;
        TEX.waterN.offset.x = t * 0.035; TEX.waterN.offset.y = t * 0.022;
        for (let i = 0; i < wN; i++) {
          const x = wbx[i], z = wbz[i];
          const a = x * 0.06 + t * 1.15, b = z * 0.05 - t * 0.95, c = (x + z) * 0.11 + t * 1.9;
          wpos.setY(i, 0.5 * Math.sin(a) + 0.42 * Math.sin(b) + 0.16 * Math.sin(c));
          const da = 0.5 * 0.06 * Math.cos(a), db = 0.42 * 0.05 * Math.cos(b), dc = 0.16 * 0.11 * Math.cos(c);
          const nx = -(da + dc), nz = -(db + dc), inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
          wnor.setXYZ(i, nx * inv, inv, nz * inv);
        }
        wpos.needsUpdate = true; wnor.needsUpdate = true;

        // wind: gusts sway all foliage via shared shader uniforms
        windUniforms.uTime.value = t;
        windUniforms.uWind.value = 0.16 + 0.14 * Math.sin(t * 0.3) + 0.07 * Math.sin(t * 0.13 + 1.0);
        // drifting clouds (cloud speed follows the wind a little)
        const windSpd = 1.0 + windUniforms.uWind.value * 4;
        for (let i = 0; i < clouds.length; i++) { const c = clouds[i]; c.grp.position.x += c.spd * windSpd * dt; if (c.grp.position.x > WORLD * 0.62) c.grp.position.x = -WORLD * 0.62; }
        // rising chimney smoke
        for (let i = 0; i < smoke.length; i++) { const sm = smoke[i]; const up = ((t * 0.7 + sm.phase) % 2.6); sm.mesh.position.y = sm.baseY + up; const k = 1 - up / 2.6; sm.mesh.scale.setScalar(0.45 + k * 0.85); }
        // floating ambient motes
        for (let i = 0; i < motes.N; i++) { let y = motes.pos[i * 3 + 1] + motes.spd[i] * dt; if (y > 40) y = 5; motes.pos[i * 3 + 1] = y; motes.pos[i * 3] += Math.sin(t * 0.4 + i) * 0.006; }
        motes.pts.geometry.attributes.position.needsUpdate = true;
        // splash SFX on entering the water (FPS)
        if (mode === 'fps') { const inW = (player.position.y <= WATER + 0.25) && (groundH < WATER + 0.2); if (inW && !inWaterPrev) sfxSplash(); inWaterPrev = inW; }
        // breath / drowning when the head goes under + underwater fog volume
        if (mode === 'fps') {
          const depthU = Math.max(0, WATER - (player.position.y + EYE));
          const under = depthU > 0.05;
          if (under) { air -= dt / 12; if (air <= 0) { respawn(); sfxSplash(); } } else if (air < 1) { air = Math.min(1, air + dt * 0.6); }
          if (_uw) _uw.style.opacity = Math.min(0.62, depthU * 0.14).toFixed(2);
          if (_br) { if (air < 0.999) { _br.style.display = 'block'; _brf.style.width = (Math.max(0, air) * 100).toFixed(0) + '%'; } else _br.style.display = 'none'; }
          if (under) { scene.fog.color.setHex(0x0f6594); scene.fog.near = 0.5; scene.fog.far = Math.max(14, 40 - depthU * 4); scene.background = _uwBg; if (skyMesh) skyMesh.visible = false; }
          else { scene.fog.color.copy(DEF_FOG.color); scene.fog.near = DEF_FOG.near; scene.fog.far = DEF_FOG.far; scene.background = null; if (skyMesh) skyMesh.visible = true; }
        } else if (_uw) { _uw.style.opacity = 0; if (_br) _br.style.display = 'none'; scene.fog.color.copy(DEF_FOG.color); scene.fog.near = DEF_FOG.near; scene.fog.far = DEF_FOG.far; scene.background = null; if (skyMesh) skyMesh.visible = true; }
        // spatial ocean ambience: louder near the shore, fades inland
        if (_ambGain && _actx) {
          _waveAcc += dt; if (_waveAcc > 0.3) {
            _waveAcc = 0;
            const fx = mode === 'god' ? godTarget.x : player.position.x, fz = mode === 'god' ? godTarget.z : player.position.z;
            const wd = waterProximity(fx, fz);
            const tg = Math.max(0.05, Math.min(0.65, 0.65 * (1 - wd / 95)));
            _ambGain.gain.setTargetAtTime(tg, _actx.currentTime, 0.5);
          }
        }

        // crystals: float, spin, collect
        let biome = 'Meadow';
        if (groundH < WATER + 1.2) biome = 'Shore'; else if (groundH > 14) biome = 'Highlands';
        currentBiome = biome;
        crystals.forEach(c => {
          if (c.got) return;
          c.mesh.rotation.y += dt * 1.5; c.mesh.rotation.x += dt * 0.6;
          c.mesh.position.y = c.baseY + Math.sin(t * 2 + c.baseY) * 0.25;
          tmpV.set(player.position.x, player.position.y, player.position.z);
          if (tmpV.distanceTo(c.mesh.position) < 2.4) { c.got = true; c.mesh.visible = false; updateScore(); sfxCollect(); }
        });
        document.getElementById('biome').textContent = biome;
        _qAcc += dt; if (_qAcc > 0.5) { _qAcc = 0; renderQuests(); }

        // golden keys: spin, bob, collect
        for (let i = 0; i < keysArr.length; i++) {
          const k = keysArr[i]; if (k.got) continue;
          k.mesh.rotation.y += dt * 2.2; k.mesh.position.y = k.baseY + Math.sin(t * 2 + i) * 0.2;
          if (Math.hypot(player.position.x - k.mesh.position.x, player.position.z - k.mesh.position.z) < 2.2 && Math.abs(player.position.y - k.mesh.position.y) < 3) {
            k.got = true; k.mesh.visible = false; keysHeld++; updateTreasureHUD(); sfxCollect(); toast('🔑 Found a golden key!');
          }
        }
        // chests: ease the lid open, and show the "press E" prompt when near a closed one
        let nearChest = false;
        for (let i = 0; i < chests.length; i++) {
          const c = chests[i]; const target = c.opened ? 1 : 0;
          c.openAmt += (target - c.openAmt) * Math.min(1, dt * 7); c.lid.rotation.x = -c.openAmt * 2.1;
          if (!c.opened && mode === 'fps' && Math.hypot(player.position.x - c.x, player.position.z - c.z) < 3.2) nearChest = true;
        }
        const cp = document.getElementById('chestPrompt');
        if (cp) { if (nearChest) { cp.classList.remove('hidden'); cp.innerHTML = keysHeld > 0 ? '🔑 Press <kbd>E</kbd> to open chest' : '🔒 Locked — find a golden key'; } else cp.classList.add('hidden'); }

        const fX = mode === 'god' ? godTarget.x : player.position.x;
        const fY = mode === 'god' ? godTarget.y : player.position.y;
        const fZ = mode === 'god' ? godTarget.z : player.position.z;
        const shHalf = mode === 'god' ? Math.min(300, 90 + godDist * 1.05) : SHADOW_HALF_FPS;
        setShadowFocus(fX, fY, fZ, shHalf);

        updateEnemies(dt, t);
        updateWildlife(dt, t);   // birds circle overhead; ground animals roam and flee enemies
        updateLootFx(dt);        // loot icons fly from the chest to the player
        updateHouses(dt);   // open doors near the player, fade walls + light up when inside
        renderer.render(scene, mode === 'god' ? godCam : camera);

        // fps
        fpsN++; fpsT += dt; if (fpsT >= 0.5) { document.getElementById('fps').textContent = Math.round(fpsN / fpsT); fpsN = 0; fpsT = 0; }
      }

      let score = 0;
      function updateScore() {
        score++; document.getElementById('got').textContent = score;
        if (score === crystals.length) { const s = document.getElementById('score'); s.innerHTML = '<div class="big" style="color:#7fe7c4">All found! 🎉</div>'; }
      }

      addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); menuTransitionCam.aspect = innerWidth / innerHeight; menuTransitionCam.updateProjectionMatrix(); godCam.aspect = innerWidth / innerHeight; godCam.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

      /* ============================================================
         LIVE "LOOK & LIGHTING" CONTROLS (sliders)
         Color depth/contrast/brightness via a canvas post-filter;
         sun strength/warmth and sky fill drive the actual lights.
         ============================================================ */
      (function () {
        const $ = id => document.getElementById(id);
        const ids = ['sSat', 'sCon', 'sBri', 'sSun', 'sWar', 'sFil'];
        const S = {}; ids.forEach(k => S[k] = $(k));
        const cool = new THREE.Color(0xfff7ec), warm = new THREE.Color(0xffbe72);
        const DEF = [115, 105, 100, 140, 50, 50];
        function apply() {
          const sat = +S.sSat.value, con = +S.sCon.value, bri = +S.sBri.value, sn = +S.sSun.value, wa = +S.sWar.value, fi = +S.sFil.value;
          canvas.style.filter = `saturate(${sat}%) contrast(${con}%) brightness(${bri}%)`;
          sun.intensity = sn / 100;
          sun.color.copy(cool).lerp(warm, wa / 100);
          hemi.intensity = fi / 100;
          $('vSat').textContent = sat + '%'; $('vCon').textContent = con + '%'; $('vBri').textContent = bri + '%';
          $('vSun').textContent = (sn / 100).toFixed(2); $('vWar').textContent = wa + '%'; $('vFil').textContent = fi + '%';
          try { localStorage.setItem('vi_look', JSON.stringify(ids.map(k => +S[k].value))); } catch (e) { }
        }
        ids.forEach(k => S[k].addEventListener('input', apply));
        try { const v = JSON.parse(localStorage.getItem('vi_look')); if (v && v.length === 6) ids.forEach((k, i) => S[k].value = v[i]); } catch (e) { }
        $('gear').addEventListener('click', toggleSettings);
        $('settingsClose').addEventListener('click', closeSettingsPanel);
        $('settingsModal').addEventListener('click', e => { if (e.target === $('settingsModal')) { closeSettingsPanel(); } });
        document.querySelector('#settingsModal .modalCard').addEventListener('click', e => { e.stopPropagation(); });
        $('sMusic').addEventListener('click', () => { startMusic(); setMusic(!musicOn); });
        $('sVol').addEventListener('input', () => { const v = +$('sVol').value; $('vVol').textContent = v + '%'; setVolume(v / 100); });
        $('sSaveB').addEventListener('click', saveBuild);
        $('sLoadB').addEventListener('click', loadBuild);
        document.querySelectorAll('#classicTrees input[data-ck]').forEach(cb => {
          cb.addEventListener('click', e => { e.stopPropagation(); });
          cb.addEventListener('change', () => {
            const id = cb.dataset.ck, ck = CLASSIC_KINDS.find(k => k.id === id);
            if (cb.checked) { if (!TREE_KINDS.find(k => k.id === id)) TREE_KINDS.push(ck); }
            else { const i = TREE_KINDS.findIndex(k => k.id === id); if (i >= 0) TREE_KINDS.splice(i, 1); }
            rebuildTreebar();
          });
        });
        document.querySelectorAll('#classicTrees label').forEach(lbl => {
          lbl.addEventListener('click', e => { e.stopPropagation(); });
        });
        $('sReset').addEventListener('click', () => { ids.forEach((k, i) => S[k].value = DEF[i]); apply(); });
        let dusk = false;
        $('sApply').addEventListener('click', () => {
          dusk = !dusk;
          const v = dusk ? [145, 120, 94, 90, 95, 34] : DEF; ids.forEach((k, i) => S[k].value = v[i]); apply();
        });
        apply();
      })();

      // instanced meshes get an origin-centred bounding sphere, so they wrongly cull when the
      // god-mode camera pans away from the centre (looks like the island "tearing"). Disable culling on them.
      scene.traverse(o => { if (o.isInstancedMesh || o.isPoints) o.frustumCulled = false; });

      // place player on a nice spot
      player.position.set(0, heightAt(0, 0) + EYE, 30);

      // hide slimes and player body initially in main menu
      enemies.forEach(e => e.visible = false);
      body.visible = false;
      head.visible = false;
      vm.visible = false;

      document.getElementById('loading').textContent = 'World ready — ' + crystals.length + ' crystals to find.';
      renderQuests();
      animate();
    })();
  