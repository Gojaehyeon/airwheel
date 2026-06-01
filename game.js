import * as THREE from "three";

const ROAD_W = 18;          // 도로 폭
const HALF = ROAD_W / 2;
const LANE = ROAD_W / 3;    // 3차선
const ROWS = 160;           // 도로 정점 행 수(곡선 부드럽게)
const VIEW = 600;           // 가시 도로 길이
const NEAR = 40;            // 카메라 앞쪽까지 도로를 깔아 화면 하단을 채움
const ROW_LEN = VIEW / ROWS;
const MAXS = 210;           // 최고 속도 천장(월드 유닛/초)
const BASE_SPEED = 80;      // 시작 구간 최고속도
const SPEED_RAMP = 0.026;   // 거리당 최고속도 증가량 → 갈수록 빨라짐(난이도↑)

/** 박스 조립식 자동차 한 대 생성 */
function makeCar(bodyColor, lightColor) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 0.6, 4),
    new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.6, roughness: 0.3 })
  );
  body.position.y = 0.6; body.castShadow = true; g.add(body);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.55, 1.8),
    new THREE.MeshStandardMaterial({ color: 0x0a0a14, metalness: 0.4, roughness: 0.2 })
  );
  cabin.position.set(0, 1.05, -0.2); cabin.castShadow = true; g.add(cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.4, 14);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const wheels = [];
  for (const [x, z] of [[-1, 1.3], [1, 1.3], [-1, -1.3], [1, -1.3]]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2; w.position.set(x, 0.45, z); w.castShadow = true;
    g.add(w); wheels.push(w);
  }
  const glow = new THREE.PointLight(lightColor, 1.6, 10);
  glow.position.set(0, 0.6, 2.2); g.add(glow);
  g.userData.wheels = wheels;
  return g;
}

/** 도로 위 장애물 생성 — 'cone'(고깔) | 'barrier'(바리케이드) */
function makeHazard(type) {
  const g = new THREE.Group();
  if (type === "barrier") {
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 1.0, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xffaa00, metalness: 0.3, roughness: 0.5 })
    );
    bar.position.y = 0.9; bar.castShadow = true; g.add(bar);
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(3.22, 0.34, 0.52),
      new THREE.MeshStandardMaterial({ color: 0x141414 })
    );
    band.position.y = 0.9; g.add(band);
    for (const x of [-1.4, 1.4]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.9, 0.18), new THREE.MeshStandardMaterial({ color: 0x888888 }));
      leg.position.set(x, 0.45, 0); g.add(leg);
    }
    g.userData.half = 1.7;
  } else {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.62, 1.5, 14),
      new THREE.MeshStandardMaterial({ color: 0xff6a00, emissive: 0xff6a00, emissiveIntensity: 0.25, roughness: 0.5 })
    );
    cone.position.y = 0.75; cone.castShadow = true; g.add(cone);
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.12, 1.0), new THREE.MeshStandardMaterial({ color: 0x1a1a1a }));
    base.position.y = 0.06; g.add(base);
    g.userData.half = 0.9;
  }
  return g;
}

export class RacingGame {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1130);
    this.scene.fog = new THREE.Fog(0x0a1130, 80, VIEW * 0.8);
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 1200);

    this._buildLights();
    this._buildSky();
    this._buildRoad();
    this._buildScenery();
    this._buildCars();

    this.reset();
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  /** 코스 중심선의 좌우 오프셋 (절대 주행거리 s의 함수 → 굽이치는 도로) */
  centerX(s) {
    return Math.sin(s * 0.0026) * 22 + Math.sin(s * 0.0062 + 1.3) * 11;
  }

  // ---------- 월드 ----------
  _buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x88aaff, 0x223044, 0.85));
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.05);
    sun.position.set(-30, 70, 30); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const c = sun.shadow.camera;
    c.left = -45; c.right = 45; c.top = 45; c.bottom = -45; c.far = 200;
    this.scene.add(sun);
    this.sun = sun;
  }

  _buildSky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { top: { value: new THREE.Color(0x0a1130) }, bot: { value: new THREE.Color(0x3a1d5c) } },
      vertexShader: `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 bot;
        void main(){ float h=normalize(vP).y*0.5+0.5; gl_FragColor=vec4(mix(bot,top,h),1.0); }`,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), mat));

    const g = new THREE.BufferGeometry();
    const pts = [];
    for (let i = 0; i < 500; i++) {
      const r = 560, t = (i * 12.9898) % (Math.PI * 2), p = ((i * 7.233) % 1) * Math.PI * 0.45;
      pts.push(Math.cos(t) * r * Math.sin(p + 0.5), Math.abs(Math.cos(p)) * 320 + 50, Math.sin(t) * r * Math.sin(p + 0.5));
    }
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.5, sizeAttenuation: false })));
  }

  /** 차선/가장자리 라인이 그려진 도로 텍스처(타일링) */
  _roadTexture() {
    const cv = document.createElement("canvas");
    cv.width = 64; cv.height = 64;
    const x = cv.getContext("2d");
    x.fillStyle = "#2b3145"; x.fillRect(0, 0, 64, 64);
    // 네온 가장자리(연속 라인)
    x.fillStyle = "#00e5ff"; x.fillRect(0, 0, 5, 64); x.fillRect(59, 0, 5, 64);
    // 중앙 차선 점선(노랑) — 1/3, 2/3 지점
    x.fillStyle = "#ffd24a";
    for (const cx of [21, 43]) x.fillRect(cx - 2, 10, 4, 38);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, VIEW / 6);
    tex.anisotropy = 4;
    return tex;
  }

  _buildRoad() {
    // 좌우 잔디(넓은 바닥)
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(600, VIEW + 300),
      new THREE.MeshStandardMaterial({ color: 0x14202f })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.05, -VIEW / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);

    // 정점 변형으로 굽이치는 도로 스트립(연속 메시)
    const verts = (ROWS + 1) * 2;
    this.roadPos = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const idx = [];
    for (let j = 0; j <= ROWS; j++) {
      const z = NEAR - j * ROW_LEN; // 카메라 앞(+NEAR)부터 먼 곳까지
      // 초기 x는 update에서 채움
      this.roadPos[(2 * j) * 3 + 1] = 0; this.roadPos[(2 * j) * 3 + 2] = z;
      this.roadPos[(2 * j + 1) * 3 + 1] = 0; this.roadPos[(2 * j + 1) * 3 + 2] = z;
      uv[(2 * j) * 2] = 0; uv[(2 * j) * 2 + 1] = j / ROWS;
      uv[(2 * j + 1) * 2] = 1; uv[(2 * j + 1) * 2 + 1] = j / ROWS;
      if (j < ROWS) {
        const a = 2 * j, b = 2 * j + 1, cc = 2 * j + 2, d = 2 * j + 3;
        idx.push(a, cc, b, b, cc, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.roadPos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.roadTex = this._roadTexture();
    const mat = new THREE.MeshBasicMaterial({ map: this.roadTex, side: THREE.DoubleSide });
    this.road = new THREE.Mesh(geo, mat);
    this.scene.add(this.road);
  }

  _buildScenery() {
    this.pillars = [];
    const geo = new THREE.BoxGeometry(0.6, 6, 0.6);
    for (let i = 0; i < 30; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const mat = new THREE.MeshBasicMaterial({ color: side < 0 ? 0x00e5ff : 0xff3d7f });
      const m = new THREE.Mesh(geo, mat);
      this.scene.add(m);
      this.pillars.push({ mesh: m, side, depth: (i / 2 | 0) * (VIEW / 15) });
    }
  }

  _buildCars() {
    this.car = makeCar(0xff2d55, 0xff2d55);
    this.car.scale.setScalar(1.4); // 플레이어 차를 더 크게
    this.scene.add(this.car);

    // 상대 차량 풀
    this.traffic = [];
    const colors = [0x3dff9e, 0xffd24a, 0x9b6cff, 0x00e5ff, 0xff8a3d, 0xffffff];
    for (let i = 0; i < 7; i++) {
      const g = makeCar(colors[i % colors.length], 0xffffff);
      g.visible = false;
      this.scene.add(g);
      this.traffic.push({ mesh: g, active: false, trackS: 0, lane: 0, speed: 0 });
    }

    // 장애물 풀(고깔/바리케이드) — 미리 두 타입 모두 준비
    this.obstacles = [];
    for (let i = 0; i < 8; i++) {
      const type = i % 3 === 0 ? "barrier" : "cone";
      const g = makeHazard(type);
      g.visible = false;
      this.scene.add(g);
      this.obstacles.push({ mesh: g, active: false, trackS: 0, lane: 0, half: g.userData.half });
    }
  }

  // ---------- 상태 ----------
  reset() {
    this.dist = 0;
    this.speed = 0;
    this.carX = this.centerX(0);
    this.camX = this.carX; // 카메라 횡위치(차를 부드럽게 따라감)
    this.tilt = 0;
    this.offroad = false;
    this.crashed = false;
    this.shake = 0;
    this.spawnTimer = 1.5;
    this.maxSpeed = BASE_SPEED;
    for (const t of this.traffic) { t.active = false; t.mesh.visible = false; }
    for (const o of this.obstacles) { o.active = false; o.mesh.visible = false; }
    this._updateRoad();
  }

  _spawnTraffic() {
    const t = this.traffic.find((t) => !t.active);
    if (!t) return;
    t.lane = ((Math.random() * 3) | 0) - 1; // -1,0,1
    t.lane *= LANE;
    t.active = true;
    t.mesh.visible = true;
    t.speed = this.maxSpeed * (0.3 + Math.random() * 0.35); // 상대차 속도(최고속도 비례)
    t.trackS = this.dist + VIEW * 0.85; // 안개 가장자리에서 등장
  }

  _spawnObstacle() {
    const o = this.obstacles.find((o) => !o.active);
    if (!o) return;
    o.lane = (((Math.random() * 3) | 0) - 1) * LANE; // -LANE,0,+LANE
    o.active = true;
    o.mesh.visible = true;
    o.trackS = this.dist + VIEW * 0.85; // 정지 장애물(전진 안 함)
  }

  _updateRoad() {
    const p = this.roadPos;
    for (let j = 0; j <= ROWS; j++) {
      const cx = this.centerX(this.dist + j * ROW_LEN - NEAR); // z=NEAR-j*ROW_LEN → depth=-z
      p[(2 * j) * 3] = cx - HALF;
      p[(2 * j + 1) * 3] = cx + HALF;
    }
    this.road.geometry.attributes.position.needsUpdate = true;
  }

  /**
   * @param {number} dt
   * @param {{steer:number,throttle:number,handsOn:boolean,brake:boolean}} input
   */
  update(dt, input) {
    if (this.crashed) { this._render(dt); return; }
    dt = Math.min(dt, 0.05);

    // ----- 난이도 램프업: 거리에 비례해 최고속도 상승 -----
    this.maxSpeed = Math.min(MAXS, BASE_SPEED + this.dist * SPEED_RAMP);
    const mx = this.maxSpeed;

    // ----- 속도 -----
    const offroadDrag = this.offroad ? 0.45 : 1;
    if (input.brake) this.speed += (8 - this.speed) * Math.min(1, dt * 3);
    else if (input.handsOn) {
      const target = (25 + input.throttle * (mx - 25)) * offroadDrag;
      this.speed += (target - this.speed) * Math.min(1, dt * 0.8);
    } else {
      this.speed += (6 - this.speed) * Math.min(1, dt * 0.6);
    }
    if (this.offroad) this.speed = Math.min(this.speed, mx * 0.4);
    this.speed = Math.max(0, this.speed);

    // ----- 조향(횡이동) -----
    const steerPow = 0.6 + (this.speed / mx) * 0.9;
    this.carX += input.steer * 20 * steerPow * dt;

    this.dist += this.speed * dt;

    // 도로 중심 대비 오프셋 → 갓길 이탈 판정
    const roadCenter = this.centerX(this.dist);
    const offset = this.carX - roadCenter;
    this.offroad = Math.abs(offset) > HALF - 1.0;
    // 너무 멀리는 못 나가게 부드럽게 막기
    const limit = HALF + 4;
    if (offset > limit) this.carX = roadCenter + limit;
    if (offset < -limit) this.carX = roadCenter - limit;
    this.car.position.set(this.carX, 0, 0);

    // 차체 기울기/롤 + 갓길 덜컹
    this.tilt += (-input.steer * 0.3 - this.tilt) * Math.min(1, dt * 8);
    this.car.rotation.z = this.tilt;
    this.car.rotation.y = -input.steer * 0.18;
    if (this.offroad) this.shake = Math.max(this.shake, 0.25);

    // 바퀴 회전
    const spin = this.speed * dt * 1.5;
    for (const w of this.car.userData.wheels) w.rotation.x += spin;

    // ----- 도로/풍경 갱신 -----
    this._updateRoad();
    for (const p of this.pillars) {
      // 코스를 따라 좌우로 휘어지며 다가오는 길가 기둥
      p.depthCur = (p.depthCur ?? p.depth);
      p.depthCur -= this.speed * dt;
      if (p.depthCur < -12) p.depthCur += VIEW;
      const z = -p.depthCur;
      const cx = this.centerX(this.dist + p.depthCur);
      p.mesh.position.set(cx + p.side * (HALF + 3), 3, z);
    }

    // ----- 스폰: 상대 차량 또는 장애물 (속도↑ → 더 자주) -----
    this.spawnTimer -= dt;
    const interval = Math.max(0.45, 1.8 - this.speed / 90);
    if (this.spawnTimer <= 0 && this.speed > 14) {
      if (Math.random() < 0.45) this._spawnObstacle(); else this._spawnTraffic();
      this.spawnTimer = interval;
    }

    // 상대 차량(전진함)
    for (const t of this.traffic) {
      if (!t.active) continue;
      t.trackS += t.speed * dt;
      const depth = t.trackS - this.dist;
      if (depth < -12) { t.active = false; t.mesh.visible = false; continue; }
      const cx = this.centerX(t.trackS) + t.lane;
      t.mesh.position.set(cx, 0, -depth);
      if (depth > -2.4 && depth < 2.4 && Math.abs(cx - this.carX) < 2.3) this._crash();
    }

    // 장애물(정지 — 플레이어가 다가감)
    for (const o of this.obstacles) {
      if (!o.active) continue;
      const depth = o.trackS - this.dist;
      if (depth < -12) { o.active = false; o.mesh.visible = false; continue; }
      const cx = this.centerX(o.trackS) + o.lane;
      o.mesh.position.set(cx, 0, -depth);
      o.mesh.rotation.y += dt * 0.6; // 살짝 회전(시인성)
      if (depth > -2.0 && depth < 2.4 && Math.abs(cx - this.carX) < 1.4 + o.half) this._crash();
    }

    this._render(dt);
  }

  _crash() {
    this.crashed = true;
    this.shake = 1.2;
    if (this.onCrash) this.onCrash(Math.floor(this.dist));
  }

  _render(dt) {
    // 카메라가 차를 부드럽게 따라가 항상 화면 중앙에 오도록(가만히 있으면 정확히 중앙)
    this.camX += (this.carX - this.camX) * Math.min(1, dt * 6);
    let camX = this.camX;
    if (this.shake > 0) { camX += Math.sin(this.dist * 60) * this.shake * 0.6; this.shake = Math.max(0, this.shake - dt * 1.5); }
    this.camera.position.set(camX, 8, 16);
    this.camera.lookAt(camX, 1.0, -30); // 정면을 바라봄(차가 화면 중앙, 커브는 도로 자체로 표현)
    // 태양 그림자 카메라가 차를 따라가도록
    this.sun.position.set(this.carX - 30, 70, 30);
    this.sun.target.position.set(this.carX, 0, -10);
    this.sun.target.updateMatrixWorld();
    // 차선 텍스처 스크롤(전진감)
    this.roadTex.offset.y -= (this.speed * dt) / 6;
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get distance() { return this.dist; }
  get kmh() { return Math.round(this.speed * 3.0); }
}
