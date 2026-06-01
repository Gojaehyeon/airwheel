import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// HandLandmarker landmark indices
const WRIST = 0;
const TIPS = [4, 8, 12, 16, 20];      // 손가락 끝
const PIPS = [3, 6, 10, 14, 18];      // 그 아래 관절
const PALM = [0, 5, 9, 13, 17];       // 손바닥 둘레(중심 계산용)

/**
 * 웹캠 + MediaPipe 손 추적을 캡슐화한다.
 * 매 프레임 read()를 호출하면 조향/스로틀 상태를 돌려준다.
 */
export class HandController {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.lastVideoTime = -1;
    this.results = null;

    // 부드러운 입력값(저역통과 필터)
    this.steer = 0;     // -1(좌) ~ +1(우)
    this.throttle = 0;  // 0 ~ 1
    this.handsOn = false;
    this.brake = false;
  }

  async init() {
    const vision = await FilesetResolver.forVisionTasks(WASM);
    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
    });
  }

  async startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = stream;
    await new Promise((res) => (this.video.onloadedmetadata = res));
    await this.video.play();
  }

  /** 손바닥 중심 (거울 좌표: x는 1-x 로 반전) */
  _palmCenter(lm) {
    let x = 0, y = 0;
    for (const i of PALM) { x += lm[i].x; y += lm[i].y; }
    return { x: 1 - x / PALM.length, y: y / PALM.length };
  }

  /** 주먹 쥔 정도 0(활짝) ~ 1(꽉) */
  _grip(lm) {
    // 손 크기(손목→중지 첫 관절)로 정규화
    const dx = lm[9].x - lm[0].x, dy = lm[9].y - lm[0].y;
    const size = Math.hypot(dx, dy) || 1e-3;
    let extended = 0;
    // 엄지 제외 네 손가락: 끝이 PIP보다 손목에서 멀면 '펴짐'
    for (let f = 1; f < 5; f++) {
      const tip = lm[TIPS[f]], pip = lm[PIPS[f]];
      const dTip = Math.hypot(tip.x - lm[0].x, tip.y - lm[0].y);
      const dPip = Math.hypot(pip.x - lm[0].x, pip.y - lm[0].y);
      if (dTip > dPip + size * 0.15) extended++;
    }
    return 1 - extended / 4; // 펴진 손가락이 적을수록 grip↑
  }

  /**
   * 한 프레임 처리. ts = performance.now()
   * @returns {{steer:number, throttle:number, handsOn:boolean, brake:boolean, hands:Array}}
   */
  read(ts) {
    if (!this.landmarker || this.video.readyState < 2) return this._state();

    if (this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      this.results = this.landmarker.detectForVideo(this.video, ts);
    }

    const lms = this.results?.landmarks ?? [];
    let targetSteer = 0, targetThrottle = 0, brake = false;
    const handsOn = lms.length >= 2;

    if (handsOn) {
      // 두 손바닥 중심(거울 좌표) 중 화면상 좌/우 결정
      const a = this._palmCenter(lms[0]);
      const b = this._palmCenter(lms[1]);
      const left = a.x <= b.x ? a : b;
      const right = a.x <= b.x ? b : a;

      // 두 손을 잇는 선의 기울기 → 핸들 각도
      const angle = Math.atan2(right.y - left.y, right.x - left.x);
      const MAX = 0.6; // 약 34°에서 풀 조향
      targetSteer = Math.max(-1, Math.min(1, angle / MAX));

      // 양손 grip 평균 → 가속
      const grip = (this._grip(lms[0]) + this._grip(lms[1])) / 2;
      targetThrottle = Math.max(0, Math.min(1, (grip - 0.25) / 0.6));

      // 양손을 화면 위쪽으로 높이 들면 브레이크
      const avgY = (left.y + right.y) / 2;
      if (avgY < 0.28) { brake = true; targetThrottle = 0; }
    }

    // 저역통과 필터로 부드럽게
    this.steer    += (targetSteer    - this.steer)    * 0.35;
    this.throttle += (targetThrottle - this.throttle) * 0.18;
    this.handsOn = handsOn;
    this.brake = brake;
    return this._state();
  }

  _state() {
    return {
      steer: this.steer,
      throttle: this.throttle,
      handsOn: this.handsOn,
      brake: this.brake,
      hands: this.results?.landmarks ?? [],
    };
  }

  /** 미리보기 캔버스에 손 랜드마크 그리기 (거울 모드 캔버스 위) */
  drawOverlay(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const lms = this.results?.landmarks ?? [];
    if (!lms.length) return;

    const conn = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [5,9],[9,10],[10,11],[11,12],
      [9,13],[13,14],[14,15],[15,16],
      [13,17],[17,18],[18,19],[19,20],[0,17],
    ];
    for (const lm of lms) {
      ctx.strokeStyle = "rgba(0,229,255,0.85)";
      ctx.lineWidth = 3;
      for (const [s, e] of conn) {
        ctx.beginPath();
        ctx.moveTo(lm[s].x * w, lm[s].y * h);
        ctx.lineTo(lm[e].x * w, lm[e].y * h);
        ctx.stroke();
      }
      ctx.fillStyle = "#ff3d7f";
      for (const p of lm) {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
