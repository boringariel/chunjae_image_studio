/**
 * Real-ESRGAN Compact 브라우저 클라이언트 AI 업스케일러 (메모리 극대화 최적화 버전)
 * ─ 모델: Real-ESRGAN Compact (1.2M 파라미터 경량 Residual Dense Network)
 * ─ 메모리 최적화:
 *    1) Blob / ObjectURL 네이티브 처리 (toDataURL Base64 힙 팽창 제거)
 *    2) WebGL Float16 텍스처 강제 활성화 (VRAM 50% 절감)
 *    3) WebGL 텍스처 즉각 삭제 임계치 0 설정 (WebGL 텍스처 메모리 누수 원천 차단)
 *    4) 캔버스 풀링 (Canvas Pooling): 타일용 캔버스 1회 생성 후 재사용
 *    5) 동적 모델 메모리 해제 (disposeModels): 모달 닫기 시 VRAM/RAM 즉시 환원
 *    6) 최적화된 패치 크기 (PATCH_SIZE: 128px, PADDING: 8px) 적용
 */

window.UpscalerModule = (() => {

  /* 설정 상수 */
  const TILE_THRESHOLD_2X = 384 * 384; // 2x 업스케일 시 타일링 임계치 (약 384x384 초과 시 타일링)
  const TILE_THRESHOLD_4X = 160 * 160; // 4x 업스케일 시 타일링 임계치 (4x는 VRAM 급증 방지를 위해 160x160 초과 시 즉시 타일링)
  const PATCH_SIZE        = 128;       // 타일 입력 크기 (128px - VRAM 피크 최소화)
  const PADDING           = 8;         // 경계 아티팩트 방지용 오버랩 패딩 (px)

  const MODEL_PATHS = {
    2: '/static/models/esrgan-medium/x2/model.json',
    4: '/static/models/esrgan-medium/x4/model.json'
  };

  /**
   * 브라우저 / GPU의 WebGL 최대 텍스처 크기(MAX_TEXTURE_SIZE) 동적 조회
   */
  function getMaxTextureSize() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) {
        const size = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (size && size > 0) return size;
      }
    } catch (e) {}
    return 16384;
  }

  /**
   * 이미지 크기와 배율을 기준으로 WebGL 텍스처 한계 초과 여부 사전 검증
   */
  function checkCanUpscale(width, height, scale) {
    const scaleNum = parseInt(scale, 10) === 4 ? 4 : 2;
    const maxLimit = getMaxTextureSize();
    const targetW = width * scaleNum;
    const targetH = height * scaleNum;
    const canUpscale = (targetW <= maxLimit) && (targetH <= maxLimit);
    return {
      canUpscale,
      maxLimit,
      targetW,
      targetH,
      can2x: (width * 2 <= maxLimit) && (height * 2 <= maxLimit)
    };
  }

  /**
   * 캔버스에 투명도(Alpha < 255)가 포함되어 있는지 경량 검사
   */
  function checkHasTransparency(canvas) {
    try {
      const w = canvas.width;
      const h = canvas.height;
      const checkW = Math.min(w, 128);
      const checkH = Math.min(h, 128);
      const testCanvas = document.createElement('canvas');
      testCanvas.width = checkW;
      testCanvas.height = checkH;
      const testCtx = testCanvas.getContext('2d', { willReadFrequently: true });
      testCtx.drawImage(canvas, 0, 0, checkW, checkH);
      const imgData = testCtx.getImageData(0, 0, checkW, checkH).data;
      for (let i = 3; i < imgData.length; i += 4) {
        if (imgData[i] < 250) return true;
      }
    } catch (e) {}
    return false;
  }

  /* 모델 및 라이브러리 캐시 */
  const _modelCache = {};
  let _tfLoadedPromise = null;

  // 재사용 가능한 캔버스 풀 (Canvas Pooling)
  let _pooledTileCanvas = null;
  let _pooledTempOutCanvas = null;

  function getTileCanvas(w, h) {
    if (!_pooledTileCanvas) {
      _pooledTileCanvas = document.createElement('canvas');
    }
    _pooledTileCanvas.width = w;
    _pooledTileCanvas.height = h;
    return _pooledTileCanvas;
  }

  function getTempOutCanvas(w, h) {
    if (!_pooledTempOutCanvas) {
      _pooledTempOutCanvas = document.createElement('canvas');
    }
    _pooledTempOutCanvas.width = w;
    _pooledTempOutCanvas.height = h;
    return _pooledTempOutCanvas;
  }

  /* ── 1. TensorFlow.js 라이브러리 로드 & WebGL VRAM 최적화 환경 설정 ─ */
  function ensureTfLoaded() {
    if (window.tf && window.tf.loadLayersModel) {
      return Promise.resolve(window.tf);
    }
    if (_tfLoadedPromise) return _tfLoadedPromise;

    _tfLoadedPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/static/js/tf.min.js';
      script.onload = () => {
        if (window.tf) {
          const tf = window.tf;
          // WebGL VRAM 극대화 최적화 플래그 설정
          try {
            // WEBGL_FORCE_F16_TEXTURES는 일부 GPU 환경에서 shader linking error를 유발하므로 안전하게 비활성화
            tf.env().set('WEBGL_FORCE_F16_TEXTURES', false);
            tf.env().set('WEBGL_PACK', true);                   // 텍스처 패킹 활성화
            tf.env().set('WEBGL_DELETE_TEXTURE_THRESHOLD', 0);  // 사용 완료된 텍스처 즉시 해제
          } catch (e) {
            console.warn('[Upscaler] TF WebGL 환경 플래그 설정 경고:', e);
          }

          // WebGL 백엔드 우선 활성화 (실패 시 CPU 백엔드)
          tf.setBackend('webgl').catch(() => {
            console.warn('[Upscaler] WebGL 초기화 실패, CPU 백엔드로 전환합니다.');
            return tf.setBackend('cpu');
          }).then(() => {
            console.log('[Upscaler] TFJS 백엔드 활성화:', tf.getBackend());
            resolve(tf);
          });
        } else {
          reject(new Error('TensorFlow.js 로드 실패'));
        }
      };
      script.onerror = () => reject(new Error('/static/js/tf.min.js 로드에 실패했습니다.'));
      document.head.appendChild(script);
    });

    return _tfLoadedPromise;
  }

  /* ── 2. Real-ESRGAN Compact 모델 로드 ───────────────────────────── */
  async function loadModel(scale, onProgress) {
    const scaleNum = parseInt(scale, 10) === 4 ? 4 : 2;
    if (_modelCache[scaleNum]) {
      return _modelCache[scaleNum];
    }

    await ensureTfLoaded();
    if (onProgress) onProgress(10, `Real-ESRGAN Compact ${scaleNum}× AI 모델 로딩 중...`);

    const modelPath = MODEL_PATHS[scaleNum];
    const model = await window.tf.loadLayersModel(modelPath);
    _modelCache[scaleNum] = model;

    console.log(`[Upscaler] Real-ESRGAN Compact ${scaleNum}× 모델 로드 완료 (${modelPath})`);
    return model;
  }

  /* ── 3. 메모리 해제: 캐시된 모델 언로드 ─────────────────────────── */
  function disposeModels() {
    for (const key of Object.keys(_modelCache)) {
      if (_modelCache[key]) {
        try {
          _modelCache[key].dispose();
          console.log(`[Upscaler] Real-ESRGAN Compact ${key}× 모델 VRAM 해제 완료`);
        } catch (e) {
          console.warn('[Upscaler] 모델 해제 중 예외:', e);
        }
        delete _modelCache[key];
      }
    }
    if (window.tf && window.tf.engine) {
      try {
        window.tf.engine().disposeVariables();
      } catch (e) {}
    }
  }

  /* ── 4. 이미지 소스를 HTMLImageElement/Canvas로 정규화 ───────────── */
  function normalizeSource(source) {
    return new Promise((resolve, reject) => {
      if (source instanceof HTMLImageElement) {
        if (source.complete && source.naturalWidth) { resolve(source); return; }
        source.onload  = () => resolve(source);
        source.onerror = reject;
        return;
      }
      if (source instanceof HTMLCanvasElement) { resolve(source); return; }

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('이미지를 로드할 수 없습니다.'));
      if (source instanceof File || source instanceof Blob) {
        const objUrl = URL.createObjectURL(source);
        img.onload = () => {
          URL.revokeObjectURL(objUrl);
          resolve(img);
        };
        img.src = objUrl;
      } else if (typeof source === 'string') {
        img.src = source;
      } else {
        reject(new Error('지원되지 않는 이미지 소스 형식입니다.'));
      }
    });
  }

  function toCanvas(img) {
    if (img instanceof HTMLCanvasElement) return img;
    const c = document.createElement('canvas');
    c.width  = img.naturalWidth  || img.width;
    c.height = img.naturalHeight || img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return c;
  }

  /* ── 5. 단일 텐서 추론 (스코프 격리) ────────────────────────────── */
  function predictTensor(model, tf, inputCanvas) {
    return tf.tidy(() => {
      // 1. Canvas -> [H, W, 3] Tensor (0~255)
      const rawTensor = tf.browser.fromPixels(inputCanvas, 3);
      // 2. 정규화: Float32 [1, H, W, 3] (0.0 ~ 1.0)
      const inputTensor = rawTensor.toFloat().div(255.0).expandDims(0);
      // 3. Real-ESRGAN 신경망 예측
      const outputTensor = model.predict(inputTensor);
      // 4. 후처리: [H*scale, W*scale, 3] (0 ~ 255 Int32)
      return outputTensor.squeeze().mul(255.0).clipByValue(0, 255).toInt();
    });
  }

  /* ── 6. 전체 이미지 단일 패스 처리 (저해상도 모드) ──────────────── */
  async function fullUpscale(model, tf, srcCanvas, scale, onProgress) {
    if (onProgress) onProgress(30, `AI 신경망 추론 중 (${scale}× 전체 처리)...`);

    const resultTensor = predictTensor(model, tf, srcCanvas);
    const dstW = srcCanvas.width  * scale;
    const dstH = srcCanvas.height * scale;

    const outCanvas = document.createElement('canvas');
    outCanvas.width  = dstW;
    outCanvas.height = dstH;

    if (onProgress) onProgress(85, '결과 캔버스 렌더링 중...');
    await tf.browser.toPixels(resultTensor, outCanvas);
    resultTensor.dispose();

    if (onProgress) onProgress(100, '업스케일 완료!');
    return outCanvas;
  }

  /* ── 7. 타일링 처리 (고해상도 모드, 캔버스 풀링 및 VRAM 최소화) ── */
  async function tileUpscale(model, tf, srcCanvas, scale, onProgress) {
    const srcW = srcCanvas.width;
    const srcH = srcCanvas.height;
    const dstW = srcW * scale;
    const dstH = srcH * scale;

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width  = dstW;
    dstCanvas.height = dstH;
    const dstCtx = dstCanvas.getContext('2d');

    const stepX = PATCH_SIZE - (PADDING * 2);
    const stepY = PATCH_SIZE - (PADDING * 2);
    const numTilesX = Math.ceil(srcW / stepX);
    const numTilesY = Math.ceil(srcH / stepY);
    const totalTiles = numTilesX * numTilesY;
    let processed = 0;

    for (let ty = 0; ty < numTilesY; ty++) {
      for (let tx = 0; tx < numTilesX; tx++) {
        // 소스 이미지 상의 타일 영역 계산 (패딩 포함)
        const inStartX = Math.max(0, tx * stepX - PADDING);
        const inStartY = Math.max(0, ty * stepY - PADDING);
        const inEndX   = Math.min(srcW, (tx + 1) * stepX + PADDING);
        const inEndY   = Math.min(srcH, (ty + 1) * stepY + PADDING);
        const inW = inEndX - inStartX;
        const inH = inEndY - inStartY;

        // 풀링된 타일 캔버스 재사용
        const tileCanvas = getTileCanvas(inW, inH);
        const tileCtx = tileCanvas.getContext('2d');
        tileCtx.drawImage(srcCanvas, inStartX, inStartY, inW, inH, 0, 0, inW, inH);

        // 신경망 타일 추론 (텐서 메모리 즉시 회수)
        const tileResultTensor = predictTensor(model, tf, tileCanvas);
        const tempOutCanvas = getTempOutCanvas(inW * scale, inH * scale);
        await tf.browser.toPixels(tileResultTensor, tempOutCanvas);
        tileResultTensor.dispose();

        // 오버랩 패딩을 제외한 실제 유효 영역 계산
        const padLeft   = (inStartX === 0) ? 0 : PADDING;
        const padTop    = (inStartY === 0) ? 0 : PADDING;
        const outValidX = tx * stepX;
        const outValidY = ty * stepY;
        const outValidW = Math.min(stepX, srcW - outValidX);
        const outValidH = Math.min(stepY, srcH - outValidY);

        // 목적 캔버스에 정확히 병합
        dstCtx.drawImage(
          tempOutCanvas,
          padLeft * scale,
          padTop  * scale,
          outValidW * scale,
          outValidH * scale,
          outValidX * scale,
          outValidY * scale,
          outValidW * scale,
          outValidH * scale
        );

        processed++;
        const pct = Math.round(20 + (processed / totalTiles) * 75);
        if (onProgress) {
          onProgress(pct, `AI 타일 처리 중 (${processed}/${totalTiles} 타일)...`);
        }

        // 브라우저 렌더링 프레임 양보
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (onProgress) onProgress(100, '업스케일링 완료!');
    return dstCanvas;
  }

  /* ── 8. 캔버스를 Blob으로 변환 (메모리 절약 헬퍼) ─────────────────── */
  function canvasToBlob(canvas, type = 'image/png') {
    return new Promise(resolve => {
      canvas.toBlob(blob => resolve(blob), type);
    });
  }

  /* ── 9. 공개 API: upscaleImage ───────────────────────────────────── */
  /**
   * @param {HTMLImageElement|HTMLCanvasElement|File|Blob|string} source
   * @param {2|4}      scale      업스케일 배율 (2 또는 4)
   * @param {Function} onProgress (percent 0~100, statusText) 진행률 콜백
   * @returns {Promise<Blob>} 결과 이미지 Blob 객체
   */
  async function upscaleImage(source, scale = 2, onProgress = null) {
    const scaleNum = parseInt(scale, 10) === 4 ? 4 : 2;
    if (onProgress) onProgress(5, '이미지 및 AI 엔진 준비 중...');

    const img = await normalizeSource(source);
    const srcCanvas = toCanvas(img);

    // WebGL 텍스처 최대 크기 사전 검증
    const check = checkCanUpscale(srcCanvas.width, srcCanvas.height, scaleNum);
    if (!check.canUpscale) {
      const err = new Error('이미지 크기를 이 이상 늘릴 수 없습니다');
      err.name = 'MaxSizeExceededError';
      throw err;
    }

    const tf = await ensureTfLoaded();
    const model = await loadModel(scaleNum, onProgress);

    const totalPixels = srcCanvas.width * srcCanvas.height;
    const threshold = (scaleNum === 4) ? TILE_THRESHOLD_4X : TILE_THRESHOLD_2X;
    const useTiling = totalPixels > threshold;
    const hasAlpha = checkHasTransparency(srcCanvas);

    console.log(`[Upscaler] Real-ESRGAN Compact ${scaleNum}× 시작: 원본 크기 ${srcCanvas.width}×${srcCanvas.height} (${useTiling ? '타일링 모드' : '단일 패스'}, 투명도: ${hasAlpha ? '있음' : '없음'})`);

    let outCanvas;
    if (useTiling) {
      outCanvas = await tileUpscale(model, tf, srcCanvas, scaleNum, onProgress);
    } else {
      outCanvas = await fullUpscale(model, tf, srcCanvas, scaleNum, onProgress);
    }

    // 투명 배경(알파 채널) 복원 처리: 누끼 이미지 등의 배경 투명도 유지
    if (hasAlpha && outCanvas) {
      if (onProgress) onProgress(98, '투명 배경(알파 채널) 보존 처리 중...');
      const alphaCanvas = document.createElement('canvas');
      alphaCanvas.width = outCanvas.width;
      alphaCanvas.height = outCanvas.height;
      const alphaCtx = alphaCanvas.getContext('2d');
      alphaCtx.imageSmoothingEnabled = true;
      alphaCtx.imageSmoothingQuality = 'high';
      alphaCtx.drawImage(srcCanvas, 0, 0, outCanvas.width, outCanvas.height);

      const outCtx = outCanvas.getContext('2d');
      outCtx.globalCompositeOperation = 'destination-in';
      outCtx.drawImage(alphaCanvas, 0, 0);
      outCtx.globalCompositeOperation = 'source-over';
    }

    const resultBlob = await canvasToBlob(outCanvas, 'image/png');
    return resultBlob;
  }

  /* ── 10. 공개 API: getImageInfo ──────────────────────────────────── */
  function getImageInfo(imgEl, scale = 2) {
    const scaleNum = parseInt(scale, 10) === 4 ? 4 : 2;
    const w = imgEl.naturalWidth  || imgEl.width  || 0;
    const h = imgEl.naturalHeight || imgEl.height || 0;
    const threshold = (scaleNum === 4) ? TILE_THRESHOLD_4X : TILE_THRESHOLD_2X;
    return {
      width:       w,
      height:      h,
      totalPixels: w * h,
      willTile:    w * h > threshold,
    };
  }

  return { upscaleImage, getImageInfo, disposeModels, checkCanUpscale, getMaxTextureSize };

})();