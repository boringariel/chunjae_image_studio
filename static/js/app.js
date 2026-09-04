/**
 * Wan2GP Flux 2 Klein 4B 메인 프론트엔드 애플리케이션
 * - 천재교육(Chunjae) UI 스타일
 * - T2I & Inpainting 작업 플로우 및 드로잉 툴 제어
 * - 오프라인 상태 시 생성 버튼 비활성화
 * - 다중 사용자 순차 대기열(Queue) 실시간 고속 폴링(500ms) 및 대기 순번 안내
 * - 갤러리 탐색 및 인페인팅 원클릭 연동
 */

document.addEventListener('DOMContentLoaded', () => {
  // 상태 변수
  let currentMode = 't2i'; // 't2i' | 'inpaint'
  let isGenerating = false;
  let isBackendOnline = false;
  let galleryImages = [];
  let selectedImage = null;
  let progressTimer = null;
  let progressStartTime = 0;
  let currentTaskId = null;

  // DOM 요소
  const btnTabT2I = document.getElementById('tabT2I');
  const btnTabInpaint = document.getElementById('tabInpaint');
  const canvasSection = document.getElementById('canvasSection');
  const canvasTitleText = document.getElementById('canvasTitleText');
  const canvasBadge = document.getElementById('canvasBadge');
  const placeholderText = document.getElementById('placeholderText');
  const promptInput = document.getElementById('positivePrompt');
  const negPromptInput = document.getElementById('negativePrompt');
  const btnGenerate = document.getElementById('btnGenerate');
  const btnGenText = document.getElementById('btnGenText');
  const btnGenSpinner = document.getElementById('btnGenSpinner');
  const serverStatusPill = document.getElementById('serverStatusPill');
  const statusText = document.getElementById('statusText');
  const galleryGrid = document.getElementById('galleryGrid');
  const btnRefreshGallery = document.getElementById('btnRefreshGallery');

  // 프로그레스 바 요소
  const progressBox = document.getElementById('progressBox');
  const progressFill = document.getElementById('progressFill');
  const progressStatusText = document.getElementById('progressStatusText');
  const progressTime = document.getElementById('progressTime');

  // 모달 요소
  const imageModal = document.getElementById('imageModal');
  const modalImage = document.getElementById('modalImage');
  const modalFilename = document.getElementById('modalFilename');
  const btnModalClose = document.getElementById('modalClose');
  const btnModalDownload = document.getElementById('btnModalDownload');
  const btnSendToInpaint = document.getElementById('btnSendToInpaint');
  const btnEvalLike = document.getElementById('btnEvalLike');
  const btnEvalDislike = document.getElementById('btnEvalDislike');
  const evalStatusBadge = document.getElementById('evalStatusBadge');

  // 1. 캔버스 매니저 초기화
  const canvasManager = new InpaintCanvasManager({
    containerId: 'canvasContainer',
    imageCanvasId: 'imageCanvas',
    maskCanvasId: 'maskCanvas',
    placeholderId: 'uploadPlaceholder',
    fileInputId: 'fileInput',
    brushSizeId: 'brushSize',
    brushSizeValId: 'brushSizeVal',
    btnBrushId: 'btnToolBrush',
    btnEraserId: 'btnToolEraser',
    btnUndoId: 'btnToolUndo',
    btnClearId: 'btnToolClear',
    uploadTriggerId: 'btnUploadImage',
    btnRemoveId: 'btnRemoveImage',
    onImageChange: (hasImg) => {
      updateGenerateButtonState();
    }
  });

  // 버튼 상태 업데이트 헬퍼
  function updateGenerateButtonState() {
    if (isGenerating) {
      btnGenerate.disabled = true;
      btnGenSpinner.style.display = 'inline-block';
      btnGenText.textContent = '이미지 생성 진행 중...';
      return;
    }

    btnGenSpinner.style.display = 'none';

    if (!isBackendOnline) {
      btnGenerate.disabled = true;
      btnGenText.textContent = '백엔드 연결 대기 중 (오프라인)';
      btnGenerate.style.cursor = 'not-allowed';
      return;
    }

    btnGenerate.disabled = false;
    btnGenerate.style.cursor = 'pointer';
    if (currentMode === 't2i') {
      btnGenText.textContent = '새 이미지 생성하기';
    } else {
      btnGenText.textContent = '인페인팅 수정 생성하기';
    }
  }

  // 2. 모드 전환 (T2I 선택 시 캔버스 영역 숨김, Inpaint 선택 시에만 표시)
  function setMode(mode) {
    currentMode = mode;
    if (mode === 't2i') {
      btnTabT2I.classList.add('active');
      btnTabInpaint.classList.remove('active');
      
      // 텍스트에서 이미지 모드에서는 캔버스 영역 숨김
      if (canvasSection) canvasSection.style.display = 'none';
      canvasManager.setDrawingEnabled(false);
    } else {
      btnTabInpaint.classList.add('active');
      btnTabT2I.classList.remove('active');
      
      // 인페인팅 모드에서는 캔버스 영역 표시
      if (canvasSection) canvasSection.style.display = 'flex';
      if (canvasTitleText) canvasTitleText.textContent = '이미지 인페인팅 (수정 영역 마스킹)';
      if (canvasBadge) {
        canvasBadge.textContent = '필수 (영역 마스킹)';
        canvasBadge.className = 'badge-tag required';
      }
      if (placeholderText) placeholderText.textContent = '수정할 원본 이미지를 업로드한 후 마스크를 칠해주세요 (필수)';
      
      canvasManager.setDrawingEnabled(true);
    }
    updateGenerateButtonState();
  }

  btnTabT2I.addEventListener('click', () => setMode('t2i'));
  btnTabInpaint.addEventListener('click', () => setMode('inpaint'));

  const currentModelLabel = document.getElementById('currentModelLabel');
  const currentResolutionLabel = document.getElementById('currentResolutionLabel');
  const currentStepsLabel = document.getElementById('currentStepsLabel');

  // 스펙 안내 바 (/html/body/main/section/div[5]) config.json 값 반영 헬퍼
  function updateSpecBar(data) {
    if (!data) return;

    // 1. 적용 모델
    if (currentModelLabel) {
      if (data.model) {
        currentModelLabel.textContent = data.model;
      } else if (data.selected_model) {
        if (Array.isArray(data.selected_model)) {
          const parts = data.selected_model.filter(x => String(x).toLowerCase() !== 'default');
          currentModelLabel.textContent = parts.join(' ') || data.selected_model.join(' ');
        } else {
          currentModelLabel.textContent = data.selected_model;
        }
      }
    }

    // 2. 해상도
    if (currentResolutionLabel && data.resolution) {
      const resStr = String(data.resolution);
      if (resStr.includes('x') || resStr.includes('X')) {
        const parts = resStr.split(/[xX]/);
        currentResolutionLabel.textContent = `${parts[0].trim()} × ${parts[1].trim()} px`;
      } else {
        currentResolutionLabel.textContent = `${resStr} px`;
      }
    }

    // 3. 스텝
    if (currentStepsLabel && data.num_inference_steps !== undefined) {
      currentStepsLabel.textContent = `${data.num_inference_steps} Steps`;
    }
  }

  // 3. 백엔드 상태 주기적 확인 (2초 간격) - config.json 변경 시 스펙 바 자동 갱신
  async function checkServerStatus() {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        isBackendOnline = !!data.online;
        const qCount = data.queue_length || 0;
        if (isBackendOnline) {
          serverStatusPill.className = 'gnb-status';
          statusText.textContent = qCount > 0 ? `백엔드 연결됨 (대기열: ${qCount}건)` : 'Wan2GP 백엔드 연결됨';
        } else {
          serverStatusPill.className = 'gnb-status offline';
          statusText.textContent = '백엔드 오프라인 (대기 중)';
        }
        // 실시간 config.json 스펙 바 갱신
        updateSpecBar(data);
      } else {
        isBackendOnline = false;
        serverStatusPill.className = 'gnb-status offline';
        statusText.textContent = '백엔드 오프라인 (대기 중)';
      }
    } catch (e) {
      isBackendOnline = false;
      serverStatusPill.className = 'gnb-status offline';
      statusText.textContent = '서버 통신 불가';
    } finally {
      updateGenerateButtonState();
    }
  }

  setInterval(checkServerStatus, 2000);
  checkServerStatus();

  async function fetchConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        updateSpecBar(data);
      }
    } catch (e) {
      console.error('설정 로드 실패:', e);
    }
  }
  fetchConfig();

  // 4. 갤러리 목록 로드
  async function loadGallery() {
    try {
      const res = await fetch('/api/gallery');
      if (res.ok) {
        const data = await res.json();
        galleryImages = data.images || [];
        renderGallery(galleryImages);
      }
    } catch (e) {
      console.error('갤러리 로드 실패:', e);
    }
  }

  function renderGallery(images) {
    if (!images || images.length === 0) {
      galleryGrid.innerHTML = `
        <div class="gallery-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#adb5bd" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <circle cx="8.5" cy="8.5" r="1.5"></circle>
            <polyline points="21 15 16 10 5 21"></polyline>
          </svg>
          <span>생성된 이미지가 없습니다.</span>
        </div>
      `;
      return;
    }

    galleryGrid.innerHTML = images.map((img, idx) => `
      <div class="gallery-item" data-index="${idx}">
        <img src="${img.url}" alt="${img.name}" loading="lazy" />
      </div>
    `).join('');

    galleryGrid.querySelectorAll('.gallery-item').forEach(el => {
      el.addEventListener('click', () => {
        const index = parseInt(el.dataset.index, 10);
        openImageModal(galleryImages[index]);
      });
    });
  }

  btnRefreshGallery.addEventListener('click', () => {
    loadGallery();
    showToast('갤러리 목록을 새로고침했습니다.');
  });

  // 5. 모달 확대 뷰어 & 인페인팅 연동 & 평가 시스템
  async function checkImageFeedback(imageName) {
    if (!imageName || !btnEvalLike || !btnEvalDislike || !evalStatusBadge) return;
    btnEvalLike.classList.remove('active');
    btnEvalDislike.classList.remove('active');
    evalStatusBadge.style.display = 'none';
    evalStatusBadge.textContent = '';

    try {
      const res = await fetch(`/api/feedback?name=${encodeURIComponent(imageName)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.rating) {
          if (data.rating.includes('👍') || data.rating.toLowerCase().includes('like')) {
            btnEvalLike.classList.add('active');
            evalStatusBadge.textContent = '평가 완료: 마음에 들어요 👍';
            evalStatusBadge.className = 'eval-status-badge success';
            evalStatusBadge.style.display = 'inline-block';
          } else if (data.rating.includes('👎') || data.rating.toLowerCase().includes('dislike')) {
            btnEvalDislike.classList.add('active');
            evalStatusBadge.textContent = '평가 완료: 별로예요 👎';
            evalStatusBadge.className = 'eval-status-badge success';
            evalStatusBadge.style.display = 'inline-block';
          }
        }
      }
    } catch (e) {
      console.warn('평가 상태 조회 실패:', e);
    }
  }

  async function sendFeedback(ratingType) {
    if (!selectedImage) return;
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_name: selectedImage.name,
          rating: ratingType
        })
      });
      const data = await res.json();
      if (data.success) {
        if (ratingType === 'like') {
          btnEvalLike.classList.add('active');
          btnEvalDislike.classList.remove('active');
          evalStatusBadge.textContent = '소중한 평가(👍)가 기록되었습니다!';
        } else {
          btnEvalDislike.classList.add('active');
          btnEvalLike.classList.remove('active');
          evalStatusBadge.textContent = '소중한 평가(👎)가 기록되었습니다!';
        }
        evalStatusBadge.className = 'eval-status-badge success';
        evalStatusBadge.style.display = 'inline-block';
        showToast('평가가 로그에 성공적으로 기록되었습니다.');
      } else {
        alert(data.error || '평가 저장에 실패했습니다.');
      }
    } catch (e) {
      console.error('평가 전송 에러:', e);
      alert('서버와 통신 중 오류가 발생했습니다.');
    }
  }

  if (btnEvalLike) {
    btnEvalLike.addEventListener('click', () => sendFeedback('like'));
  }
  if (btnEvalDislike) {
    btnEvalDislike.addEventListener('click', () => sendFeedback('dislike'));
  }

  function openImageModal(img) {
    if (!img) return;
    selectedImage = img;
    modalImage.src = img.url;
    modalFilename.textContent = img.name;
    imageModal.style.display = 'flex';
    checkImageFeedback(img.name);
  }

  function closeModal() {
    imageModal.style.display = 'none';
    selectedImage = null;
  }

  btnModalClose.addEventListener('click', closeModal);
  imageModal.addEventListener('click', (e) => {
    if (e.target === imageModal) closeModal();
  });

  btnModalDownload.addEventListener('click', () => {
    if (!selectedImage) return;
    const a = document.createElement('a');
    a.href = selectedImage.url;
    a.download = selectedImage.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  btnSendToInpaint.addEventListener('click', () => {
    if (!selectedImage) return;
    canvasManager.loadImageFromUrl(selectedImage.url);
    setMode('inpaint');
    closeModal();
    showToast('이미지를 인페인팅 캔버스로 불러왔습니다. 브러시로 수정할 영역을 지정해주세요.');
    canvasSection.scrollIntoView({ behavior: 'smooth' });
  });

  // 6. 실시간 진행 상태 애니메이션 관리
  function startProgressUI() {
    progressStartTime = Date.now();
    progressBox.style.display = 'flex';
    progressFill.style.width = '10%';
    progressStatusText.textContent = '대기열에 등록 중...';
    progressTime.textContent = '0.0s';

    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      const elapsedSec = (Date.now() - progressStartTime) / 1000;
      progressTime.textContent = `${elapsedSec.toFixed(1)}s`;
    }, 200);
  }

  function updateProgressState(status, queuePos) {
    const elapsedSec = (Date.now() - progressStartTime) / 1000;
    if (status === 'queued') {
      progressFill.style.width = '15%';
      progressStatusText.textContent = `대기열 대기 중... (대기 순번: ${queuePos}번째)`;
    } else if (status === 'processing') {
      if (elapsedSec < 2.5) {
        progressFill.style.width = `${25 + elapsedSec * 15}%`;
        progressStatusText.textContent = 'FLUX.2 Klein 4B 텍스트 인코딩 중...';
      } else if (elapsedSec < 8.0) {
        progressFill.style.width = `${55 + (elapsedSec - 2.5) * 6}%`;
        progressStatusText.textContent = 'GPU 정류 흐름 추론 중 (Step 1~3 / 4)...';
      } else {
        progressFill.style.width = '92%';
        progressStatusText.textContent = '디노이징 마무리 및 이미지 저장 중...';
      }
    }
  }

  function stopProgressUI(success = true) {
    if (progressTimer) clearInterval(progressTimer);
    if (success) {
      progressFill.style.width = '100%';
      progressStatusText.textContent = '이미지 생성 완료!';
      setTimeout(() => {
        progressBox.style.display = 'none';
      }, 1500);
    } else {
      progressBox.style.display = 'none';
    }
  }

  // 7. 대기열 작업 등록 및 완료 폴링
  btnGenerate.addEventListener('click', async () => {
    if (isGenerating || !isBackendOnline) return;

    const prompt = promptInput.value.trim();
    const negPrompt = negPromptInput.value.trim();

    if (!prompt) {
      alert('포지티브 프롬프트를 입력해주세요.');
      promptInput.focus();
      return;
    }

    if (currentMode === 'inpaint' && !canvasManager.hasImage) {
      alert('인페인팅 모드에서는 수정할 원본 이미지를 업로드해야 합니다.');
      return;
    }

    if (currentMode === 'inpaint' && !canvasManager.hasMask()) {
      alert('수정할 영역을 브러시로 마스킹해주세요.\n마스크(주황색 영역)가 없으면 이미지가 수정되지 않습니다.');
      return;
    }

    isGenerating = true;
    updateGenerateButtonState();
    startProgressUI();

    const payload = {
      mode: currentMode,
      prompt: prompt,
      negative_prompt: negPrompt,
      seed: -1,
      image: currentMode === 'inpaint' ? canvasManager.getSourceImageBase64() : null,
      mask: currentMode === 'inpaint' ? canvasManager.getMaskImageBase64() : null
    };

    console.log('[프론트엔드] 이미지 생성 요청 발송:', payload);

    try {
      // 1. 대기열 등록 요청
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const genData = await res.json();
      console.log('[프론트엔드] 대기열 등록 응답:', genData);

      if (!genData.success || !genData.task_id) {
        stopProgressUI(false);
        alert(genData.error || '대기열 등록에 실패했습니다.');
        isGenerating = false;
        updateGenerateButtonState();
        return;
      }

      currentTaskId = genData.task_id;
      showToast(`작업이 대기열에 등록되었습니다. (대기 순번: ${genData.queue_position}번)`);

      // 2. 대기열 작업 상태 고속 폴링 (500ms 간격)
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/task_status?task_id=${currentTaskId}`);
          if (!statusRes.ok) return;

          const sData = await statusRes.json();
          updateProgressState(sData.status, sData.queue_position);

          if (sData.status === 'completed') {
            clearInterval(pollInterval);
            stopProgressUI(true);
            const elapsed = ((Date.now() - progressStartTime) / 1000).toFixed(1);
            showToast(`이미지 생성 완료! (${elapsed}초 소요)`);
            await loadGallery();
            if (galleryImages.length > 0) {
              openImageModal(galleryImages[0]);
            }
            isGenerating = false;
            updateGenerateButtonState();
          } else if (sData.status === 'failed') {
            clearInterval(pollInterval);
            stopProgressUI(false);
            const errMsg = sData.result ? sData.result.error : '생성에 실패했습니다.';
            alert(`[오류] ${errMsg}`);
            isGenerating = false;
            updateGenerateButtonState();
          }
        } catch (pollErr) {
          console.error('상태 폴링 오류:', pollErr);
        }
      }, 500);

    } catch (e) {
      stopProgressUI(false);
      console.error('생성 요청 에러:', e);
      alert('서버와 통신 중 오류가 발생했습니다.');
      isGenerating = false;
      updateGenerateButtonState();
    }
  });

  // 8. 토스트 알림 헬퍼
  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4cd137" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
      <span>${message}</span>
    `;
    const container = document.getElementById('toastContainer');
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // 9. 배경 제거(누끼따기) 기능 - 모든 처리는 브라우저에서만 수행되며 갤러리/로그에는 저장/기록되지 않음
  const tabBgRemove = document.getElementById('tabBgRemove');
  const bgRemoveModal = document.getElementById('bgRemoveModal');
  const bgRemoveModalClose = document.getElementById('bgRemoveModalClose');
  const btnBgRemoveClose2 = document.getElementById('btnBgRemoveClose2');
  const bgDropZone = document.getElementById('bgDropZone');
  const bgFileInput = document.getElementById('bgFileInput');
  const bgLoading = document.getElementById('bgLoading');
  const bgStatusText = document.getElementById('bgStatusText');
  const bgPreviewContainer = document.getElementById('bgPreviewContainer');
  const bgOriginalImg = document.getElementById('bgOriginalImg');
  const bgResultImg = document.getElementById('bgResultImg');
  const bgDownloadBtn = document.getElementById('bgDownloadBtn');
  const btnSendToBgRemove = document.getElementById('btnSendToBgRemove');

  function openBgRemoveModal() {
    if (!bgRemoveModal) return;
    bgRemoveModal.style.display = 'flex';
  }

  function closeBgRemoveModal() {
    if (!bgRemoveModal) return;
    bgRemoveModal.style.display = 'none';
  }

  function resetBgRemoveUI() {
    bgDropZone.style.display = 'flex';
    bgLoading.style.display = 'none';
    bgPreviewContainer.style.display = 'none';
    bgDownloadBtn.style.display = 'none';
    bgStatusText.textContent = 'AI가 배경을 제거하고 있습니다... (최초 실행 시 AI 모델 다운로드로 시간이 소요될 수 있습니다)';
  }

  // 실제 배경 제거 AI 처리 (원본 미리보기는 이미 화면에 표시된 상태에서 호출됨)
  async function runBgRemoval(imageSource) {
    bgDropZone.style.display = 'none';
    bgPreviewContainer.style.display = 'none';
    bgDownloadBtn.style.display = 'none';
    bgLoading.style.display = 'flex';

    try {
      if (typeof window.removeBackground !== 'function') {
        throw new Error('AI 모듈 로딩 중입니다. 잠시 후 다시 시도해 주세요.');
      }

      const resultBlob = await window.removeBackground(imageSource, {
        progress: (key, current, total) => {
          if (total) {
            const percent = Math.round((current / total) * 100);
            bgStatusText.textContent = `AI 모델 다운로드 중: ${percent}%`;
          }
        }
      });

      const resultUrl = URL.createObjectURL(resultBlob);
      bgResultImg.src = resultUrl;
      bgDownloadBtn.href = resultUrl;

      bgPreviewContainer.style.display = 'flex';
      bgDownloadBtn.style.display = 'inline-block';
    } catch (error) {
      console.error('배경 제거 오류:', error);
      alert('배경 처리 실패: ' + error.message);
      bgDropZone.style.display = 'flex';
    } finally {
      bgLoading.style.display = 'none';
    }
  }

  // 파일 업로드(드래그/클릭)로 들어온 이미지 처리
  async function processBgRemoval(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      alert('이미지 파일만 업로드해 주세요.');
      return;
    }
    bgOriginalImg.src = URL.createObjectURL(file);
    await runBgRemoval(file);
  }

  // 갤러리에서 지정한 이미지를 지연 없이 즉시 배경 제거 입력으로 사용
  async function processBgRemovalFromUrl(url, fileName) {
    // 원본 미리보기는 대기 없이 즉시 표시
    bgOriginalImg.src = url;
    bgDropZone.style.display = 'none';
    bgPreviewContainer.style.display = 'none';
    bgDownloadBtn.style.display = 'none';
    bgLoading.style.display = 'flex';

    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], fileName || 'source.png', { type: blob.type || 'image/png' });
      await runBgRemoval(file);
    } catch (e) {
      console.error('갤러리 이미지 불러오기 실패:', e);
      alert('선택한 이미지를 불러오는 중 오류가 발생했습니다.');
      bgLoading.style.display = 'none';
      bgDropZone.style.display = 'flex';
    }
  }

  if (tabBgRemove) {
    tabBgRemove.addEventListener('click', () => {
      resetBgRemoveUI();
      openBgRemoveModal();
    });
  }

  if (bgRemoveModalClose) bgRemoveModalClose.addEventListener('click', closeBgRemoveModal);
  if (btnBgRemoveClose2) btnBgRemoveClose2.addEventListener('click', closeBgRemoveModal);
  if (bgRemoveModal) {
    bgRemoveModal.addEventListener('click', (e) => {
      if (e.target === bgRemoveModal) closeBgRemoveModal();
    });
  }

  if (bgDropZone) {
    bgDropZone.addEventListener('click', () => bgFileInput.click());

    ['dragenter', 'dragover'].forEach(eventName => {
      bgDropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        bgDropZone.classList.add('hover');
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      bgDropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        bgDropZone.classList.remove('hover');
      });
    });

    bgDropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length > 0) processBgRemoval(files[0]);
    });
  }

  if (bgFileInput) {
    bgFileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) processBgRemoval(e.target.files[0]);
    });
  }

  // 갤러리 상세 모달에서 배경 제거 기능으로 이미지 전달 - 클릭 즉시 해당 이미지로 배경 제거 실행
  if (btnSendToBgRemove) {
    btnSendToBgRemove.addEventListener('click', () => {
      if (!selectedImage) return;
      const targetImage = selectedImage;
      closeModal();
      openBgRemoveModal();
      processBgRemovalFromUrl(targetImage.url, targetImage.name);
    });
  }

  // 10. 업스케일링 기능 - Real-ESRGAN Compact AI 모델 (클라이언트 구동 & 메모리 최적화)
  const tabUpscale                = document.getElementById('tabUpscale');
  const upscaleModal              = document.getElementById('upscaleModal');
  const upscaleModalClose         = document.getElementById('upscaleModalClose');
  const btnUpscaleClose2          = document.getElementById('btnUpscaleClose2');
  const upscaleDropZone           = document.getElementById('upscaleDropZone');
  const upscaleFileInput          = document.getElementById('upscaleFileInput');
  const upscaleLoading            = document.getElementById('upscaleLoading');
  const upscaleStatusText         = document.getElementById('upscaleStatusText');
  const upscaleProgressBox        = document.getElementById('upscaleProgressBox');
  const upscaleProgressFill       = document.getElementById('upscaleProgressFill');
  const upscalePreview            = document.getElementById('upscalePreviewContainer');
  const upscaleOrigImg            = document.getElementById('upscaleOriginalImg');
  const upscaleResultImg          = document.getElementById('upscaleResultImg');
  const upscaleResultPlaceholder  = document.getElementById('upscaleResultPlaceholder');
  const upscaleOrigLabel          = document.getElementById('upscaleOrigLabel');
  const upscaleResultLabel        = document.getElementById('upscaleResultLabel');
  const upscaleDownloadBtn        = document.getElementById('upscaleDownloadBtn');
  const btnScale2                 = document.getElementById('btnScale2');
  const btnScale4                 = document.getElementById('btnScale4');
  const btnRunUpscale             = document.getElementById('btnRunUpscale');
  const btnRunUpscaleText         = document.getElementById('btnRunUpscaleText');
  const btnUpscaleReset           = document.getElementById('btnUpscaleReset');
  const btnSendToUpscale          = document.getElementById('btnSendToUpscale');

  let selectedUpscaleScale = 2;
  let currentUpscaleSource = null;     // File | Blob | string
  let currentUpscaleOrigUrl = null;    // ObjectURL (원본)
  let currentUpscaleResultUrl = null;  // ObjectURL (결과)
  let currentUpscaleResultBlob = null; // Blob (결과 Blob - 추가 업스케일링 시 새 소스로 활용)
  let isUpscaling = false;

  // 배율 선택 버튼 처리 (선택 시 바로 실행되지 않고 버튼 텍스트만 갱신)
  [btnScale2, btnScale4].forEach(btn => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      [btnScale2, btnScale4].forEach(b => b && b.classList.remove('active'));
      btn.classList.add('active');
      selectedUpscaleScale = parseInt(btn.dataset.scale, 10);
      if (btnRunUpscaleText && !isUpscaling) {
        if (currentUpscaleResultBlob) {
          btnRunUpscaleText.textContent = `${selectedUpscaleScale}× 추가 업스케일링`;
        } else {
          btnRunUpscaleText.textContent = `${selectedUpscaleScale}× 업스케일링 시작`;
        }
      }
    });
  });

  function openUpscaleModal() {
    if (!upscaleModal) return;
    upscaleModal.style.display = 'flex';
  }

  function closeUpscaleModal() {
    if (!upscaleModal) return;
    upscaleModal.style.display = 'none';
    resetUpscaleUI();
    // 모달 닫기 시 AI 모델 VRAM 메모리 즉시 반환
    if (window.UpscalerModule && typeof window.UpscalerModule.disposeModels === 'function') {
      window.UpscalerModule.disposeModels();
    }
  }

  // ObjectURL 메모리 안전 해제
  function clearUpscaleUrls() {
    if (currentUpscaleOrigUrl && currentUpscaleOrigUrl.startsWith('blob:')) {
      URL.revokeObjectURL(currentUpscaleOrigUrl);
      currentUpscaleOrigUrl = null;
    }
    if (currentUpscaleResultUrl && currentUpscaleResultUrl.startsWith('blob:')) {
      URL.revokeObjectURL(currentUpscaleResultUrl);
      currentUpscaleResultUrl = null;
    }
  }

  function resetUpscaleUI() {
    clearUpscaleUrls();
    currentUpscaleSource = null;
    currentUpscaleResultBlob = null;
    isUpscaling = false;

    if (upscaleDropZone) upscaleDropZone.style.display = 'flex';
    if (upscaleLoading) upscaleLoading.style.display = 'none';
    if (upscaleProgressBox) upscaleProgressBox.style.display = 'none';
    if (upscaleProgressFill) upscaleProgressFill.style.width = '0%';
    if (upscalePreview) upscalePreview.style.display = 'none';
    if (upscaleDownloadBtn) upscaleDownloadBtn.style.display = 'none';
    if (btnRunUpscale) {
      btnRunUpscale.style.display = 'none';
      btnRunUpscale.disabled = false;
    }
    if (btnUpscaleReset) btnUpscaleReset.style.display = 'none';
    if (btnRunUpscaleText) btnRunUpscaleText.textContent = `${selectedUpscaleScale}× 업스케일링 시작`;
    if (upscaleStatusText) upscaleStatusText.textContent = 'Real-ESRGAN Compact AI 모델 준비 완료';
  }

  // 진행률 업데이트 헬퍼
  function setUpscaleProgress(pct, msg) {
    if (upscaleProgressFill) upscaleProgressFill.style.width = pct + '%';
    if (msg && upscaleStatusText) upscaleStatusText.textContent = msg;
  }

  // 이미지 입력 등록 (즉시 실행하지 않고 미리보기 및 시작 버튼 표시)
  function setUpscaleInput(fileOrBlob, previewUrl) {
    // 이전 ObjectURL 정리
    if (currentUpscaleOrigUrl && currentUpscaleOrigUrl.startsWith('blob:') && currentUpscaleOrigUrl !== previewUrl) {
      URL.revokeObjectURL(currentUpscaleOrigUrl);
    }
    if (currentUpscaleResultUrl && currentUpscaleResultUrl.startsWith('blob:')) {
      URL.revokeObjectURL(currentUpscaleResultUrl);
      currentUpscaleResultUrl = null;
    }

    currentUpscaleSource = fileOrBlob;
    currentUpscaleOrigUrl = previewUrl;
    currentUpscaleResultBlob = null;

    if (upscaleDropZone) upscaleDropZone.style.display = 'none';
    if (upscalePreview) upscalePreview.style.display = 'flex';
    if (upscaleLoading) upscaleLoading.style.display = 'none';
    if (upscaleProgressBox) upscaleProgressBox.style.display = 'none';

    // 원본 이미지 표시
    if (upscaleOrigImg) {
      upscaleOrigImg.src = previewUrl;
      upscaleOrigImg.onload = () => {
        const w = upscaleOrigImg.naturalWidth || 0;
        const h = upscaleOrigImg.naturalHeight || 0;
        if (upscaleOrigLabel) upscaleOrigLabel.textContent = `원본 이미지 (${w}×${h} px)`;
      };
    }

    // 결과 영역을 대기 플레이스홀더 상태로 초기화
    if (upscaleResultImg) {
      upscaleResultImg.src = '';
      upscaleResultImg.style.display = 'none';
    }
    if (upscaleResultPlaceholder) upscaleResultPlaceholder.style.display = 'flex';
    if (upscaleResultLabel) upscaleResultLabel.textContent = '업스케일 결과 대기 중';
    if (upscaleDownloadBtn) upscaleDownloadBtn.style.display = 'none';

    // 시작 버튼 및 재선택 버튼 노출
    if (btnRunUpscale) {
      btnRunUpscale.style.display = 'inline-flex';
      btnRunUpscale.disabled = false;
    }
    if (btnRunUpscaleText) btnRunUpscaleText.textContent = `${selectedUpscaleScale}× 업스케일링 시작`;
    if (btnUpscaleReset) btnUpscaleReset.style.display = 'inline-flex';
  }

  // 실제 업스케일 추론 실행 (버튼 클릭 시에만 호출)
  async function runUpscale() {
    if (!currentUpscaleSource || isUpscaling) return;

    // 추가 업스케일링 모드: 이전 결과물이 존재할 경우 이를 새 원본으로 전환
    if (currentUpscaleResultBlob) {
      currentUpscaleSource = currentUpscaleResultBlob;

      // 이전 원본 ObjectURL 해제
      if (currentUpscaleOrigUrl && currentUpscaleOrigUrl.startsWith('blob:') && currentUpscaleOrigUrl !== currentUpscaleResultUrl) {
        URL.revokeObjectURL(currentUpscaleOrigUrl);
      }
      currentUpscaleOrigUrl = currentUpscaleResultUrl; // 이전 결과 URL을 새 원본 URL로 승격

      const prevW = upscaleResultImg ? (upscaleResultImg.naturalWidth || 0) : 0;
      const prevH = upscaleResultImg ? (upscaleResultImg.naturalHeight || 0) : 0;

      if (upscaleOrigImg && currentUpscaleOrigUrl) {
        upscaleOrigImg.src = currentUpscaleOrigUrl;
        if (upscaleOrigLabel) upscaleOrigLabel.textContent = `원본 이미지 (${prevW}×${prevH} px)`;
      }

      // 결과 영역 초기화
      currentUpscaleResultUrl = null;
      currentUpscaleResultBlob = null;
      if (upscaleResultImg) {
        upscaleResultImg.src = '';
        upscaleResultImg.style.display = 'none';
      }
      if (upscaleResultPlaceholder) upscaleResultPlaceholder.style.display = 'flex';
      if (upscaleResultLabel) upscaleResultLabel.textContent = '추가 업스케일 결과 대기 중';
      if (upscaleDownloadBtn) upscaleDownloadBtn.style.display = 'none';
    }

    // 사전 크기 검증 (WebGL 한계치 초과 여부 확인)
    if (window.UpscalerModule && typeof window.UpscalerModule.checkCanUpscale === 'function' && upscaleOrigImg) {
      const origW = upscaleOrigImg.naturalWidth || 0;
      const origH = upscaleOrigImg.naturalHeight || 0;
      if (origW > 0 && origH > 0) {
        const check = window.UpscalerModule.checkCanUpscale(origW, origH, selectedUpscaleScale);
        if (!check.canUpscale) {
          alert('이미지 크기를 이 이상 늘릴 수 없습니다');
          return;
        }
      }
    }

    isUpscaling = true;
    if (btnRunUpscale) btnRunUpscale.disabled = true;
    if (btnUpscaleReset) btnUpscaleReset.style.display = 'none';
    if (upscaleDownloadBtn) upscaleDownloadBtn.style.display = 'none';
    if (upscaleLoading) upscaleLoading.style.display = 'flex';
    if (upscaleProgressBox) upscaleProgressBox.style.display = 'block';
    if (upscaleProgressFill) upscaleProgressFill.style.width = '0%';

    try {
      if (!window.UpscalerModule || typeof window.UpscalerModule.upscaleImage !== 'function') {
        throw new Error('업스케일링 모듈이 아직 로딩 중입니다. 잠시 후 다시 시도해주세요.');
      }

      setUpscaleProgress(5, 'Real-ESRGAN Compact AI 엔진 초기화 중...');

      const scale = selectedUpscaleScale;
      const resultBlob = await window.UpscalerModule.upscaleImage(
        currentUpscaleSource,
        scale,
        (pct, msg) => {
          setUpscaleProgress(pct, msg || `${scale}× AI 업스케일 추론 중... (${pct}%)`);
        }
      );

      // 이전 결과 ObjectURL 회수 (메모리 누수 차단)
      if (currentUpscaleResultUrl && currentUpscaleResultUrl.startsWith('blob:')) {
        URL.revokeObjectURL(currentUpscaleResultUrl);
      }
      currentUpscaleResultBlob = resultBlob;
      currentUpscaleResultUrl = URL.createObjectURL(resultBlob);

      // 결과 화면 렌더링
      if (upscaleResultImg) {
        upscaleResultImg.src = currentUpscaleResultUrl;
        upscaleResultImg.style.display = 'block';
      }
      if (upscaleResultPlaceholder) upscaleResultPlaceholder.style.display = 'none';

      // 크기 레이블 갱신
      const tempImg = new Image();
      tempImg.onload = () => {
        const origW = upscaleOrigImg ? (upscaleOrigImg.naturalWidth || 0) : 0;
        const origH = upscaleOrigImg ? (upscaleOrigImg.naturalHeight || 0) : 0;
        if (upscaleOrigLabel) upscaleOrigLabel.textContent = `원본 이미지 (${origW}×${origH} px)`;
        if (upscaleResultLabel) upscaleResultLabel.textContent = `${scale}× 업스케일 결과 (${tempImg.naturalWidth}×${tempImg.naturalHeight} px)`;
      };
      tempImg.src = currentUpscaleResultUrl;

      // 다운로드 링크 설정
      if (upscaleDownloadBtn) {
        upscaleDownloadBtn.href = currentUpscaleResultUrl;
        upscaleDownloadBtn.style.display = 'inline-block';
      }

      if (btnRunUpscale) {
        btnRunUpscale.style.display = 'inline-flex';
        btnRunUpscale.disabled = false;
      }
      if (btnRunUpscaleText) btnRunUpscaleText.textContent = `${scale}× 추가 업스케일링`;
      if (btnUpscaleReset) btnUpscaleReset.style.display = 'inline-flex';

      showToast(`${scale}× 업스케일링이 성공적으로 완료되었습니다!`);

    } catch (err) {
      console.error('[Upscaler] 처리 오류:', err);
      const errMsg = (err && err.message) ? err.message : '';
      if (
        (err && err.name === 'MaxSizeExceededError') ||
        errMsg.includes('이 이상 늘릴 수 없습니다') ||
        errMsg.includes('WebGL maximum') ||
        errMsg.includes('texture size') ||
        errMsg.includes('greater than WebGL')
      ) {
        alert('이미지 크기를 이 이상 늘릴 수 없습니다');
      } else {
        alert('업스케일링 처리 실패: ' + errMsg);
      }
      if (btnRunUpscale) {
        btnRunUpscale.style.display = 'inline-flex';
        btnRunUpscale.disabled = false;
      }
      if (btnUpscaleReset) btnUpscaleReset.style.display = 'inline-flex';
    } finally {
      isUpscaling = false;
      if (upscaleLoading) upscaleLoading.style.display = 'none';
      if (upscaleProgressBox) upscaleProgressBox.style.display = 'none';
    }
  }

  // 업스케일 시작 버튼 이벤트 바인딩
  if (btnRunUpscale) {
    btnRunUpscale.addEventListener('click', () => {
      runUpscale();
    });
  }

  // 다른 이미지 선택 버튼 이벤트
  if (btnUpscaleReset) {
    btnUpscaleReset.addEventListener('click', () => {
      resetUpscaleUI();
    });
  }

  // 파일(드래그/클릭) 처리 -> 즉시 실행하지 않고 입력 등록
  function handleUpscaleFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      alert('이미지 파일만 업로드해 주세요.');
      return;
    }
    const origSrc = URL.createObjectURL(file);
    setUpscaleInput(file, origSrc);
  }

  // 갤러리 URL 처리 -> 즉시 실행하지 않고 입력 등록
  async function handleUpscaleFromUrl(url, fileName) {
    resetUpscaleUI();
    if (upscaleDropZone) upscaleDropZone.style.display = 'none';
    if (upscaleLoading) upscaleLoading.style.display = 'flex';
    if (upscaleStatusText) upscaleStatusText.textContent = '갤러리 이미지 불러오는 중...';

    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], fileName || 'source.png', { type: blob.type || 'image/png' });
      const origSrc = URL.createObjectURL(file);
      setUpscaleInput(file, origSrc);
    } catch (e) {
      console.error('[Upscaler] 갤러리 이미지 로드 실패:', e);
      alert('선택한 이미지를 불러오는 중 오류가 발생했습니다.');
      resetUpscaleUI();
    }
  }

  // 탭 버튼 클릭 → 모달 열기
  if (tabUpscale) {
    tabUpscale.addEventListener('click', () => {
      resetUpscaleUI();
      openUpscaleModal();
    });
  }

  // 모달 닫기
  if (upscaleModalClose) upscaleModalClose.addEventListener('click', closeUpscaleModal);
  if (btnUpscaleClose2) btnUpscaleClose2.addEventListener('click', closeUpscaleModal);
  if (upscaleModal) {
    upscaleModal.addEventListener('click', (e) => {
      if (e.target === upscaleModal) closeUpscaleModal();
    });
  }

  // 드롭존 클릭 / 드래그앤드롭
  if (upscaleDropZone) {
    upscaleDropZone.addEventListener('click', () => upscaleFileInput && upscaleFileInput.click());

    ['dragenter', 'dragover'].forEach(ev => {
      upscaleDropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        upscaleDropZone.classList.add('hover');
      });
    });
    ['dragleave', 'drop'].forEach(ev => {
      upscaleDropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        upscaleDropZone.classList.remove('hover');
      });
    });
    upscaleDropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length > 0) handleUpscaleFile(files[0]);
    });
  }

  if (upscaleFileInput) {
    upscaleFileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) handleUpscaleFile(e.target.files[0]);
    });
  }

  // 갤러리 상세 모달 → 업스케일링으로 보내기
  if (btnSendToUpscale) {
    btnSendToUpscale.addEventListener('click', () => {
      if (!selectedImage) return;
      const targetImage = selectedImage;
      closeModal();
      openUpscaleModal();
      handleUpscaleFromUrl(targetImage.url, targetImage.name);
    });
  }

  // 초기 로드: T2I 기본 모드로 시작
  loadGallery();
  setMode('t2i');
});
