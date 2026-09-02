/**
 * Wan2GP Flux 2 Klein 4B 인페인팅 캔버스 모듈
 * - 720x720 표준 해상도 버퍼
 * - 브러시 / 지우개 툴
 * - 모드별 드로잉 툴 활성화 / 비활성화 제어
 * - 되돌리기(Undo), 전체 지우기(Clear)
 * - 드래그앤드롭, 클립보드 붙여넣기, 갤러리 이미지 연동 지원
 */

class InpaintCanvasManager {
  constructor(options) {
    this.container = document.getElementById(options.containerId);
    this.imgCanvas = document.getElementById(options.imageCanvasId);
    this.maskCanvas = document.getElementById(options.maskCanvasId);
    this.placeholder = document.getElementById(options.placeholderId);
    this.fileInput = document.getElementById(options.fileInputId);
    this.brushSizeInput = document.getElementById(options.brushSizeId);
    this.brushSizeVal = document.getElementById(options.brushSizeValId);
    this.btnBrush = document.getElementById(options.btnBrushId);
    this.btnEraser = document.getElementById(options.btnEraserId);
    this.btnUndo = document.getElementById(options.btnUndoId);
    this.btnClear = document.getElementById(options.btnClearId);
    this.fileUploadTrigger = document.getElementById(options.uploadTriggerId);
    this.fileRemoveTrigger = document.getElementById(options.btnRemoveId);
    this.onImageChangeCallback = options.onImageChange || null;

    this.imgCtx = this.imgCanvas.getContext('2d');
    this.maskCtx = this.maskCanvas.getContext('2d');

    // 720x720 고정 버퍼 크기
    this.targetWidth = 720;
    this.targetHeight = 720;

    this.currentTool = 'brush'; // 'brush' | 'eraser'
    this.brushSize = 30;
    this.isDrawing = false;
    this.hasImage = false;
    this.isDrawingEnabled = true;
    this.history = [];
    this.maxHistory = 15;

    this.init();
  }

  init() {
    this.setCanvasDimensions(this.targetWidth, this.targetHeight);
    this.initCursorRing();
    this.bindEvents();
  }

  initCursorRing() {
    // 마우스 커서 주위 브러시/지우개 반경 링 엘리먼트 생성
    let ring = document.getElementById('brushCursorRing');
    if (!ring) {
      ring = document.createElement('div');
      ring.id = 'brushCursorRing';
      ring.className = 'brush-cursor-ring';
      document.body.appendChild(ring);
    }
    this.cursorRing = ring;
  }

  setCanvasDimensions(width, height) {
    this.imgCanvas.width = width;
    this.imgCanvas.height = height;
    this.maskCanvas.width = width;
    this.maskCanvas.height = height;
  }

  // T2I / Inpaint 모드에 따른 드로잉 도구 활성화 / 비활성화
  setDrawingEnabled(enabled) {
    this.isDrawingEnabled = enabled;
    
    // 툴바 버튼 비활성화 스타일
    const tools = [this.btnBrush, this.btnEraser, this.btnUndo, this.btnClear, this.brushSizeInput];
    tools.forEach(el => {
      if (el) {
        el.disabled = !enabled;
        el.style.opacity = enabled ? '1' : '0.4';
        el.style.pointerEvents = enabled ? 'auto' : 'none';
      }
    });

    if (this.maskCanvas) {
      this.maskCanvas.style.pointerEvents = enabled ? 'auto' : 'none';
    }

    if (this.cursorRing) {
      this.cursorRing.style.display = 'none';
    }

    // T2I 탭 전환 시 마스크 초기화하지 않음:
    // 사용자가 실수로 탭을 전환했다가 인페인팅으로 돌아올 때 마스크가 사라지는 문제 방지
  }

  // 마스크가 실제로 그려져 있는지 확인
  hasMask() {
    if (!this.hasImage) return false;
    const maskData = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    for (let i = 3; i < maskData.data.length; i += 4) {
      if (maskData.data[i] > 20) return true;
    }
    return false;
  }

  updateCursorRing(e) {
    if (!this.cursorRing) return;
    if (!this.isDrawingEnabled || !this.hasImage) {
      this.cursorRing.style.display = 'none';
      return;
    }

    const rect = this.maskCanvas.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      this.cursorRing.style.display = 'none';
      return;
    }

    // 화면 상에서의 렌더링된 캔버스 스케일 계산
    const scale = rect.width / this.maskCanvas.width;
    const diameter = Math.max(4, this.brushSize * scale);

    this.cursorRing.style.width = `${diameter}px`;
    this.cursorRing.style.height = `${diameter}px`;
    this.cursorRing.style.left = `${e.clientX}px`;
    this.cursorRing.style.top = `${e.clientY}px`;
    this.cursorRing.className = `brush-cursor-ring ${this.currentTool === 'eraser' ? 'eraser' : ''}`;
    this.cursorRing.style.display = 'block';
  }

  bindEvents() {
    // 1. 툴 선택 이벤트
    if (this.btnBrush) {
      this.btnBrush.addEventListener('click', () => this.setTool('brush'));
    }
    if (this.btnEraser) {
      this.btnEraser.addEventListener('click', () => this.setTool('eraser'));
    }
    if (this.btnUndo) {
      this.btnUndo.addEventListener('click', () => this.undo());
    }
    if (this.btnClear) {
      this.btnClear.addEventListener('click', () => this.clearMask());
    }

    // 2. 브러시 크기 슬라이더
    if (this.brushSizeInput) {
      this.brushSizeInput.addEventListener('input', (e) => {
        this.brushSize = parseInt(e.target.value, 10);
        if (this.brushSizeVal) {
          this.brushSizeVal.innerText = `${this.brushSize}px`;
        }
        if (this.lastMousePos) {
          this.updateCursorRing(this.lastMousePos);
        }
      });
    }

    // 3. 파일 업로드 및 삭제 트리거
    if (this.fileUploadTrigger && this.fileInput) {
      this.fileUploadTrigger.addEventListener('click', () => {
        this.fileInput.click();
      });
      this.fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          this.loadImageFromFile(e.target.files[0]);
        }
      });
    }

    if (this.fileRemoveTrigger) {
      this.fileRemoveTrigger.addEventListener('click', () => {
        this.resetAll();
      });
    }

    // 4. 컨테이너 클릭 시 이미지 없을 때 파일 선택 열기
    this.container.addEventListener('click', (e) => {
      if (!this.hasImage && e.target !== this.fileUploadTrigger && e.target !== this.fileRemoveTrigger) {
        if (this.fileInput) this.fileInput.click();
      }
    });

    // 5. 드래그 앤 드롭
    this.container.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.container.classList.add('dragover');
    });
    this.container.addEventListener('dragleave', () => {
      this.container.classList.remove('dragover');
    });
    this.container.addEventListener('drop', (e) => {
      e.preventDefault();
      this.container.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        this.loadImageFromFile(e.dataTransfer.files[0]);
      }
    });

    // 6. 클립보드 붙여넣기 (Ctrl + V)
    window.addEventListener('paste', (e) => {
      const items = (e.clipboardData || e.originalEvent.clipboardData).items;
      for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
          const blob = item.getAsFile();
          this.loadImageFromFile(blob);
          break;
        }
      }
    });

    // 7. 마우스 드로잉 및 커서 링 이벤트
    this.maskCanvas.addEventListener('mouseenter', (e) => {
      this.lastMousePos = e;
      this.updateCursorRing(e);
    });

    this.maskCanvas.addEventListener('mousemove', (e) => {
      this.lastMousePos = e;
      this.updateCursorRing(e);
      if (this.isDrawing) {
        this.draw(e);
      }
    });

    this.maskCanvas.addEventListener('mouseleave', () => {
      if (this.cursorRing) {
        this.cursorRing.style.display = 'none';
      }
    });

    this.maskCanvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // 좌클릭만
      this.startDrawing(e);
    });

    window.addEventListener('mouseup', () => this.stopDrawing());

    // 8. 터치 이벤트
    this.maskCanvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        this.startDrawing(e.touches[0]);
      }
    });
    this.maskCanvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        this.draw(e.touches[0]);
      }
    });
    window.addEventListener('touchend', () => this.stopDrawing());
  }

  setTool(tool) {
    if (!this.isDrawingEnabled) return;
    this.currentTool = tool;
    if (this.btnBrush) this.btnBrush.classList.toggle('active', tool === 'brush');
    if (this.btnEraser) this.btnEraser.classList.toggle('active', tool === 'eraser');
    if (this.cursorRing && this.lastMousePos) {
      this.updateCursorRing(this.lastMousePos);
    }
  }

  saveState() {
    if (this.history.length >= this.maxHistory) {
      this.history.shift();
    }
    const state = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    this.history.push(state);
  }

  undo() {
    if (!this.isDrawingEnabled) return;
    if (this.history.length > 0) {
      const prevState = this.history.pop();
      this.maskCtx.putImageData(prevState, 0, 0);
    } else {
      this.clearMask(false);
    }
  }

  clearMask(recordHistory = true) {
    if (recordHistory && this.isDrawingEnabled) {
      this.saveState();
    }
    this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
  }

  getCanvasCoords(e) {
    const rect = this.maskCanvas.getBoundingClientRect();
    const scaleX = this.maskCanvas.width / rect.width;
    const scaleY = this.maskCanvas.height / rect.height;

    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }

  drawPoint(x, y) {
    const radius = (this.brushSize * (this.maskCanvas.width / 720)) / 2;
    this.maskCtx.save();
    this.maskCtx.beginPath();
    this.maskCtx.arc(x, y, radius, 0, Math.PI * 2);
    if (this.currentTool === 'brush') {
      this.maskCtx.globalCompositeOperation = 'source-over';
      this.maskCtx.fillStyle = 'rgba(255, 90, 0, 0.75)';
    } else {
      this.maskCtx.globalCompositeOperation = 'destination-out';
      this.maskCtx.fillStyle = 'rgba(0, 0, 0, 1)';
    }
    this.maskCtx.fill();
    this.maskCtx.restore();
  }

  drawLine(x1, y1, x2, y2) {
    this.maskCtx.save();
    this.maskCtx.beginPath();
    this.maskCtx.lineCap = 'round';
    this.maskCtx.lineJoin = 'round';
    this.maskCtx.lineWidth = this.brushSize * (this.maskCanvas.width / 720);

    if (this.currentTool === 'brush') {
      this.maskCtx.globalCompositeOperation = 'source-over';
      this.maskCtx.strokeStyle = 'rgba(255, 90, 0, 0.75)';
    } else {
      this.maskCtx.globalCompositeOperation = 'destination-out';
      this.maskCtx.strokeStyle = 'rgba(0, 0, 0, 1)';
    }

    this.maskCtx.moveTo(x1, y1);
    this.maskCtx.lineTo(x2, y2);
    this.maskCtx.stroke();
    this.maskCtx.restore();
  }

  startDrawing(e) {
    if (!this.hasImage || !this.isDrawingEnabled) return;
    this.saveState();
    this.isDrawing = true;
    const coords = this.getCanvasCoords(e);
    this.lastX = coords.x;
    this.lastY = coords.y;
    this.drawPoint(coords.x, coords.y);
  }

  draw(e) {
    if (!this.isDrawing || !this.hasImage || !this.isDrawingEnabled) return;
    const coords = this.getCanvasCoords(e);
    this.drawLine(this.lastX, this.lastY, coords.x, coords.y);
    this.lastX = coords.x;
    this.lastY = coords.y;
  }

  stopDrawing() {
    this.isDrawing = false;
  }

  loadImageFromFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      this.loadImageFromDataUrl(e.target.result);
    };
    reader.readAsDataURL(file);
  }

  loadImageFromDataUrl(dataUrl) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.drawImageScaled(img);
    };
    img.src = dataUrl;
  }

  loadImageFromUrl(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.drawImageScaled(img);
    };
    img.src = url;
  }

  drawImageScaled(img) {
    this.setCanvasDimensions(this.targetWidth, this.targetHeight);
    this.imgCtx.clearRect(0, 0, this.targetWidth, this.targetHeight);
    this.maskCtx.clearRect(0, 0, this.targetWidth, this.targetHeight);
    this.history = [];

    const imgRatio = img.width / img.height;
    const canvasRatio = this.targetWidth / this.targetHeight;
    let renderW = this.targetWidth;
    let renderH = this.targetHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (imgRatio > canvasRatio) {
      renderH = this.targetWidth / imgRatio;
      offsetY = (this.targetHeight - renderH) / 2;
    } else {
      renderW = this.targetHeight * imgRatio;
      offsetX = (this.targetWidth - renderW) / 2;
    }

    this.imgCtx.fillStyle = '#000000';
    this.imgCtx.fillRect(0, 0, this.targetWidth, this.targetHeight);
    this.imgCtx.drawImage(img, offsetX, offsetY, renderW, renderH);

    this.hasImage = true;
    if (this.placeholder) {
      this.placeholder.style.display = 'none';
    }
    if (this.fileRemoveTrigger) {
      this.fileRemoveTrigger.style.display = 'inline-flex';
    }
    if (this.onImageChangeCallback) {
      this.onImageChangeCallback(true);
    }
  }

  getSourceImageBase64() {
    if (!this.hasImage) return null;
    return this.imgCanvas.toDataURL('image/png');
  }

  getMaskImageBase64() {
    if (!this.hasImage) return null;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.targetWidth;
    tempCanvas.height = this.targetHeight;
    const tempCtx = tempCanvas.getContext('2d');

    tempCtx.fillStyle = '#000000';
    tempCtx.fillRect(0, 0, this.targetWidth, this.targetHeight);

    const maskData = this.maskCtx.getImageData(0, 0, this.targetWidth, this.targetHeight);
    const outImgData = tempCtx.createImageData(this.targetWidth, this.targetHeight);
    const len = maskData.data.length;

    for (let i = 0; i < len; i += 4) {
      const alpha = maskData.data[i + 3];
      if (alpha > 20) {
        outImgData.data[i] = 255;
        outImgData.data[i + 1] = 255;
        outImgData.data[i + 2] = 255;
        outImgData.data[i + 3] = 255;
      } else {
        outImgData.data[i] = 0;
        outImgData.data[i + 1] = 0;
        outImgData.data[i + 2] = 0;
        outImgData.data[i + 3] = 255;
      }
    }
    tempCtx.putImageData(outImgData, 0, 0);
    return tempCanvas.toDataURL('image/png');
  }

  resetAll() {
    this.imgCtx.clearRect(0, 0, this.targetWidth, this.targetHeight);
    this.maskCtx.clearRect(0, 0, this.targetWidth, this.targetHeight);
    this.history = [];
    this.hasImage = false;
    if (this.placeholder) {
      this.placeholder.style.display = 'flex';
    }
    if (this.fileInput) {
      this.fileInput.value = '';
    }
    if (this.fileRemoveTrigger) {
      this.fileRemoveTrigger.style.display = 'none';
    }
    if (this.cursorRing) {
      this.cursorRing.style.display = 'none';
    }
    if (this.onImageChangeCallback) {
      this.onImageChangeCallback(false);
    }
  }
}

window.InpaintCanvasManager = InpaintCanvasManager;
