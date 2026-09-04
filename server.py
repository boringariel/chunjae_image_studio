import socket
import sys
sys.excepthook = sys.__excepthook__
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Wan2GP 한국어 프론트엔드 서버
- ThreadingHTTPServer & threading.RLock 탑재: 데드락 방지, 병렬 처리
- 격리된 프로세스 실행기: generation_worker.py 연동
- 다중 사용자 순차 대기열 (FIFO Queue) 시스템
"""

import os
import sys
import json
import time
import uuid
import queue
import tempfile
import threading
import subprocess
import mimetypes
import urllib.request
import urllib.parse
from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler

# 기본 경로
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WAN_APP_DIR_CANDIDATES = [
    r"C:\pinokio\api\wan.git\app",
    r"C:\pinokio\api\wan2gp-amd.git\app"
]
WAN_APP_DIR = next((p for p in WAN_APP_DIR_CANDIDATES if os.path.exists(p)), WAN_APP_DIR_CANDIDATES[0])
WAN_VENV_PYTHON = os.path.join(WAN_APP_DIR, "venv", "Scripts", "python.exe")
PYTHON_EXE = WAN_VENV_PYTHON if os.path.exists(WAN_VENV_PYTHON) else sys.executable
WORKER_SCRIPT = os.path.join(BASE_DIR, "generation_worker.py")

# UTF-8 콘솔 출력 지원
try:
    if sys.stdout.encoding != 'utf-8':
        sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

# 기본 설정 로드
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
DEFAULT_CONFIG = {
    "wan2gp_url": "http://10.41.0.125:42003",
    "server_host": "0.0.0.0",
    "server_port": 8080,
    "outputs_path": os.path.join(WAN_APP_DIR, "outputs"),
    "inputs_path": "inputs",
    "log_path": "log",
    "model": "flux2_klein_4b",
    "resolution": "720x720",
    "width": 720,
    "height": 720,
    "num_inference_steps": 4,
    "guidance_scale": 1.0,
    "Enhance Prompt via LLM": "Based on both Text Prompt and Images Prompts Content",
    "NAG_scale": 1.1,
    "NAG_tau": 3.5,
    "NAG_alpha": 0.5,
    "masking_strength": 1.0,
    "denoising_strength": 0.75,
    "mask_expand_shrink": 0,
    "selected_model": ["Flux2", "Klein 4B", "Default"]
}

def load_config():
    cfg = DEFAULT_CONFIG.copy()
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                file_cfg = json.load(f)
                cfg.update(file_cfg)
        except Exception as e:
            print(f"[경고] 설정 파일 로드 실패: {e}")
    return cfg

CONFIG = load_config()
STATIC_DIR = os.path.join(BASE_DIR, "static")

def get_outputs_dir():
    cur_cfg = load_config()
    out_path = cur_cfg.get("outputs_path", "").strip()
    if not out_path:
        out_path = os.path.join(BASE_DIR, "outputs")
    elif not os.path.isabs(out_path):
        out_path = os.path.join(BASE_DIR, out_path)
    return os.path.abspath(out_path)

def get_inputs_dir():
    cur_cfg = load_config()
    p = cur_cfg.get("inputs_path", "inputs")
    if not os.path.isabs(p):
        p = os.path.join(BASE_DIR, p)
    os.makedirs(p, exist_ok=True)
    return os.path.abspath(p)

def get_log_dir():
    cur_cfg = load_config()
    p = cur_cfg.get("log_path", "log")
    if not os.path.isabs(p):
        p = os.path.join(BASE_DIR, p)
    os.makedirs(p, exist_ok=True)
    return os.path.abspath(p)

def get_sys_log_dir():
    p = os.path.join(get_log_dir(), "sys")
    os.makedirs(p, exist_ok=True)
    return p

# ── 시스템 이벤트 로그 & 제작 로그 관리 ──────────────────────────────
SYS_LOG_LOCK = threading.Lock()
GEN_LOG_LOCK = threading.Lock()

def log_system_event(level, event_type, message, exc=None):
    """log/sys/event.log 에 서비스 실행/에러/이벤트 기록"""
    now_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    log_line = f"[{now_str}] [{level.upper()}] [{event_type}] {message}\n"
    if exc:
        import traceback
        tb = traceback.format_exc()
        if tb and "NoneType: None" not in tb:
            log_line += f"Traceback:\n{tb}\n"

    try:
        sys_dir = get_sys_log_dir()
        log_file = os.path.join(sys_dir, "event.log")
        with SYS_LOG_LOCK:
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(log_line)
    except Exception as e:
        print(f"[!] 시스템 로그 기록 실패: {e}")

    # 콘솔에도 출력
    print(f"[{level.upper()}] [{event_type}] {message}")

def record_generation_log(entry):
    """log/generation.log 및 log/generation_history.json 에 제작 로그 기록"""
    try:
        log_dir = get_log_dir()
        history_file = os.path.join(log_dir, "generation_history.json")
        log_text_file = os.path.join(log_dir, "generation.log")

        with GEN_LOG_LOCK:
            history = []
            if os.path.exists(history_file):
                try:
                    with open(history_file, "r", encoding="utf-8") as f:
                        history = json.load(f)
                except Exception:
                    history = []

            img_name = entry.get("image_name", "")
            idx = next((i for i, h in enumerate(history) if h.get("image_name") == img_name), -1)
            if idx >= 0:
                history[idx].update(entry)
            else:
                history.append(entry)

            with open(history_file, "w", encoding="utf-8") as f:
                json.dump(history, f, ensure_ascii=False, indent=2)

            with open(log_text_file, "w", encoding="utf-8") as f:
                f.write("=" * 80 + "\n")
                f.write("                      [Wan2GP 이미지 제작 로그]\n")
                f.write("=" * 80 + "\n\n")
                for h in reversed(history):
                    f.write(f"[제작 일시] {h.get('start_time', '알 수 없음')}\n")
                    f.write(f"- 소요 시간: {h.get('elapsed_time', '알 수 없음')}\n")
                    f.write(f"- 포지티브 프롬프트: {h.get('positive_prompt', '')}\n")
                    f.write(f"- 네거티브 프롬프트: {h.get('negative_prompt', '') or '없음'}\n")
                    f.write(f"- 업로드한 이미지 경로: {h.get('input_image_path', '없음')}\n")
                    f.write(f"- 생성된 이미지 경로: {h.get('output_image_path', '알 수 없음')}\n")
                    f.write(f"- 평가: {h.get('rating', '미평가')}\n")
                    f.write("-" * 80 + "\n\n")

    except Exception as e:
        log_system_event("ERROR", "GEN_LOG_ERROR", f"제작 로그 저장 실패: {e}", exc=e)

def update_generation_feedback(image_name, rating_label):
    """평가(좋아요/별로예요)를 매칭하여 로그 업데이트"""
    try:
        log_dir = get_log_dir()
        history_file = os.path.join(log_dir, "generation_history.json")
        log_text_file = os.path.join(log_dir, "generation.log")

        with GEN_LOG_LOCK:
            if not os.path.exists(history_file):
                return False, "로그 파일이 존재하지 않습니다."

            with open(history_file, "r", encoding="utf-8") as f:
                history = json.load(f)

            found = False
            for h in history:
                if h.get("image_name") == image_name or os.path.basename(h.get("output_image_path", "")) == image_name:
                    h["rating"] = rating_label
                    found = True

            if not found:
                for h in history:
                    if image_name in h.get("output_image_path", ""):
                        h["rating"] = rating_label
                        found = True
                        break

            if found:
                with open(history_file, "w", encoding="utf-8") as f:
                    json.dump(history, f, ensure_ascii=False, indent=2)

                with open(log_text_file, "w", encoding="utf-8") as f:
                    f.write("=" * 80 + "\n")
                    f.write("                      [Wan2GP 이미지 제작 로그]\n")
                    f.write("=" * 80 + "\n\n")
                    for h in reversed(history):
                        f.write(f"[제작 일시] {h.get('start_time', '알 수 없음')}\n")
                        f.write(f"- 소요 시간: {h.get('elapsed_time', '알 수 없음')}\n")
                        f.write(f"- 포지티브 프롬프트: {h.get('positive_prompt', '')}\n")
                        f.write(f"- 네거티브 프롬프트: {h.get('negative_prompt', '') or '없음'}\n")
                        f.write(f"- 업로드한 이미지 경로: {h.get('input_image_path', '없음')}\n")
                        f.write(f"- 생성된 이미지 경로: {h.get('output_image_path', '알 수 없음')}\n")
                        f.write(f"- 평가: {h.get('rating', '미평가')}\n")
                        f.write("-" * 80 + "\n\n")

                log_system_event("INFO", "FEEDBACK_RECEIVED", f"이미지: {image_name} | 평가: {rating_label}")
                return True, "평가가 성공적으로 기록되었습니다."
            else:
                return False, "해당 이미지의 생성 로그를 찾을 수 없습니다."

    except Exception as e:
        log_system_event("ERROR", "FEEDBACK_ERROR", f"평가 업데이트 실패: {e}", exc=e)
        return False, str(e)


def check_or_detect_wan2gp():
    cur_cfg = load_config()
    target_url = cur_cfg.get("wan2gp_url", "http://10.41.0.125:42003").rstrip("/")
    try:
        req = urllib.request.Request(target_url, headers={"User-Agent": "Wan2GP-Front"})
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            if resp.status in [200, 301, 302]:
                CONFIG["wan2gp_url"] = target_url
                return True, target_url, "정상 연결됨"
    except Exception:
        pass

    CONFIG["wan2gp_url"] = target_url
    return False, target_url, f"Wan2GP 백엔드 오프라인 (대기 중: {target_url})"

# =========================================================================
# 다중 사용자 순차 대기열 (FIFO Queue) 시스템 - RLock으로 데드락 완전 방지
# =========================================================================
TASK_QUEUE = queue.Queue()
TASK_STATUS_LOCK = threading.RLock()
ACTIVE_TASKS = {}
CURRENT_PROCESSING_TASK_ID = None

def get_queue_position(task_id):
    with TASK_STATUS_LOCK:
        if task_id == CURRENT_PROCESSING_TASK_ID:
            return 0  # 처리 중
        pos = 1
        for item in list(TASK_QUEUE.queue):
            if item["task_id"] == task_id:
                return pos
            pos += 1
        return -1

def execute_task_subprocess(task_item):
    """독립된 프로세스로 generation_worker.py를 실행하여 100% 안전하게 생성"""
    task_id = task_item["task_id"]
    payload = task_item["payload"]
    prompt = payload.get("prompt", "")
    neg_prompt = payload.get("negative_prompt", "")
    start_time_stamp = time.time()
    start_time_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(start_time_stamp))

    def parse_selected_model(sel):
        if isinstance(sel, list) and len(sel) == 3:
            family, base, variant = sel
            f_str = str(family).lower().strip()
            b_str = str(base).lower().strip().replace(" ", "_")
            if str(variant).lower().strip() == "base":
                b_str = b_str.replace("klein", "klein_base")
            return f"{f_str}_{b_str}"
        return sel if isinstance(sel, str) else "flux2_klein_4b"

    print(f"\n=======================================================")
    print(f"[*] [Task {task_id}] 생성 시작 (Prompt: {prompt[:35]}...)")
    print(f"=======================================================")
    log_system_event("INFO", "TASK_START", f"TaskID: {task_id} | Prompt: '{prompt[:40]}' | Mode: {payload.get('mode', 't2i')}")

    fresh_cfg = load_config()

    task_payload = payload.copy()
    task_payload["wan2gp_url"] = fresh_cfg.get("wan2gp_url", "http://10.41.0.125:42003")
    task_payload["outputs_path"] = get_outputs_dir()
    task_payload["inputs_path"] = get_inputs_dir()
    task_payload["log_path"] = get_log_dir()

    # config.json의 최신 설정값 적용 (서버 재시작 없이 즉시 반영)
    task_payload["resolution"] = fresh_cfg.get("resolution", "720x720")
    task_payload["width"] = fresh_cfg.get("width", 720)
    task_payload["height"] = fresh_cfg.get("height", 720)
    task_payload["num_inference_steps"] = fresh_cfg.get("num_inference_steps", 4)
    task_payload["guidance_scale"] = fresh_cfg.get("guidance_scale", 1.0)

    task_payload["prompt_enhancer_label"] = fresh_cfg.get("Enhance Prompt via LLM", "")
    task_payload["NAG_scale"] = fresh_cfg.get("NAG_scale")
    task_payload["NAG_tau"] = fresh_cfg.get("NAG_tau")
    task_payload["NAG_alpha"] = fresh_cfg.get("NAG_alpha")
    task_payload["masking_strength"] = fresh_cfg.get("masking_strength", 1.0)
    task_payload["denoising_strength"] = fresh_cfg.get("denoising_strength", 0.75)
    task_payload["mask_expand_shrink"] = fresh_cfg.get("mask_expand_shrink", 0)
    if not task_payload.get("target_model"):
        task_payload["target_model"] = parse_selected_model(fresh_cfg.get("selected_model", "flux2_klein_4b"))

    # 작업 매개변수 임시 파일 생성
    tfile = tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w", encoding="utf-8")
    json.dump(task_payload, tfile, ensure_ascii=False)
    tfile.close()
    task_file_path = tfile.name
    result_file_path = task_file_path + ".result"

    try:
        cmd = [PYTHON_EXE, WORKER_SCRIPT, task_file_path]
        res = subprocess.run(cmd, timeout=180)

        result = None
        if os.path.exists(result_file_path):
            try:
                with open(result_file_path, "r", encoding="utf-8") as f:
                    result = json.load(f)
            except Exception as e:
                log_system_event("ERROR", "RESULT_READ_ERROR", f"결과 파일 읽기 오류 (Task {task_id}): {e}", exc=e)

        if not result:
            err_msg = f"워커 프로세스 비정상 종료 (종료 코드: {res.returncode})"
            result = {"success": False, "error": err_msg}
            log_system_event("ERROR", "WORKER_PROCESS_ERROR", f"Task {task_id} 실패: {err_msg}")

        # 제작 완료 후 로그 기록
        if result.get("success"):
            img_name = result.get("image_name", "")
            out_img_path = result.get("image_path") or os.path.join(get_outputs_dir(), img_name)
            elapsed_time_val = result.get("elapsed_time")
            if not elapsed_time_val:
                elapsed_sec = max(0.1, time.time() - start_time_stamp)
                elapsed_time_val = f"{elapsed_sec:.1f}초"

            input_img_path = task_payload.get("input_image_path") or "없음"

            log_entry = {
                "task_id": task_id,
                "start_time": start_time_str,
                "elapsed_time": elapsed_time_val,
                "positive_prompt": prompt,
                "negative_prompt": neg_prompt,
                "input_image_path": input_img_path,
                "output_image_path": out_img_path,
                "image_name": img_name,
                "rating": "미평가"
            }
            record_generation_log(log_entry)
            log_system_event("INFO", "TASK_COMPLETED", f"TaskID: {task_id} | 생성 완료: {img_name} | 소요 시간: {elapsed_time_val}")
        else:
            log_system_event("ERROR", "TASK_FAILED", f"TaskID: {task_id} | 에러: {result.get('error')}")

        return result

    except Exception as e:
        log_system_event("ERROR", "SUBPROCESS_EXEC_ERROR", f"Task {task_id} 서브프로세스 실행 실패: {e}", exc=e)
        return {"success": False, "error": str(e)}

    finally:
        if os.path.exists(task_file_path):
            try: os.remove(task_file_path)
            except Exception: pass
        if os.path.exists(result_file_path):
            try: os.remove(result_file_path)
            except Exception: pass

def queue_worker_loop():
    """백그라운드에서 순차적으로 대기열 작업을 처리하는 단일 워커 스레드"""
    global CURRENT_PROCESSING_TASK_ID
    while True:
        try:
            task_item = TASK_QUEUE.get()
            task_id = task_item["task_id"]
            
            with TASK_STATUS_LOCK:
                CURRENT_PROCESSING_TASK_ID = task_id
                ACTIVE_TASKS[task_id]["status"] = "processing"
                ACTIVE_TASKS[task_id]["started_at"] = time.time()

            # GPU 추론 독립 프로세스 실행
            result = execute_task_subprocess(task_item)

            with TASK_STATUS_LOCK:
                ACTIVE_TASKS[task_id]["status"] = "completed" if result.get("success") else "failed"
                ACTIVE_TASKS[task_id]["result"] = result
                ACTIVE_TASKS[task_id]["completed_at"] = time.time()
                CURRENT_PROCESSING_TASK_ID = None

            TASK_QUEUE.task_done()
        except Exception as e:
            log_system_event("ERROR", "QUEUE_WORKER_ERROR", f"대기열 워커 스레드 예외 발생: {e}", exc=e)
            time.sleep(1)

# =========================================================================
# 멀티스레드 HTTP 서버 핸들러
# =========================================================================
class FrontHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        if len(args) > 0 and isinstance(args[0], str) and ("/api/status" in args[0] or "/api/task_status" in args[0]):
            return
        super().log_message(format, *args)

    def send_json(self, data, status_code=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            query = urllib.parse.parse_qs(parsed.query)

            # 1. API: 서버 및 백엔드 상태 (config.json 값 실시간 반영)
            if path == "/api/status":
                is_alive, active_url, status_text = check_or_detect_wan2gp()
                with TASK_STATUS_LOCK:
                    queue_length = TASK_QUEUE.qsize() + (1 if CURRENT_PROCESSING_TASK_ID else 0)
                cur_cfg = load_config()

                sel_model = cur_cfg.get("selected_model", "flux2_klein_4b")
                model_name = "Flux 2 Klein 4B"
                if isinstance(sel_model, list):
                    model_name = " ".join([str(x) for x in sel_model if str(x).lower() != "default"])
                elif isinstance(sel_model, str) and sel_model:
                    model_name = sel_model

                self.send_json({
                    "online": is_alive,
                    "status_text": status_text,
                    "wan2gp_url": active_url,
                    "model": model_name,
                    "selected_model": sel_model,
                    "resolution": cur_cfg.get("resolution", "720x720"),
                    "width": cur_cfg.get("width", 720),
                    "height": cur_cfg.get("height", 720),
                    "num_inference_steps": cur_cfg.get("num_inference_steps", 4),
                    "guidance_scale": cur_cfg.get("guidance_scale", 1.0),
                    "queue_length": queue_length,
                    "outputs_dir": get_outputs_dir(),
                    "inputs_dir": get_inputs_dir(),
                    "log_dir": get_log_dir()
                })
                return

            # 1-b. API: 모델 목록 및 현재 선택 모델/설정 조회 (config.json 값 실시간 반영)
            if path == "/api/config":
                try:
                    fresh_cfg = load_config()
                    sel_model = fresh_cfg.get("selected_model", "flux2_klein_4b")
                    model_name = "Flux 2 Klein 4B"
                    if isinstance(sel_model, list):
                        model_name = " ".join([str(x) for x in sel_model if str(x).lower() != "default"])
                    elif isinstance(sel_model, str) and sel_model:
                        model_name = sel_model

                    self.send_json({
                        "model": model_name,
                        "selected_model": sel_model,
                        "resolution": fresh_cfg.get("resolution", "720x720"),
                        "width": fresh_cfg.get("width", 720),
                        "height": fresh_cfg.get("height", 720),
                        "num_inference_steps": fresh_cfg.get("num_inference_steps", 4),
                        "guidance_scale": fresh_cfg.get("guidance_scale", 1.0),
                        "Enhance Prompt via LLM": fresh_cfg.get("Enhance Prompt via LLM", ""),
                        "NAG_scale": fresh_cfg.get("NAG_scale", 1.1),
                        "NAG_tau": fresh_cfg.get("NAG_tau", 3.5),
                        "NAG_alpha": fresh_cfg.get("NAG_alpha", 0.5),
                        "models": fresh_cfg.get("models", [])
                    })
                except Exception as e:
                    log_system_event("ERROR", "CONFIG_GET_ERROR", f"설정 조회 오류: {e}", exc=e)
                    self.send_json({"error": str(e)}, 500)
                return

            # 1-c. API: 이미지 평가 상태 조회
            if path == "/api/feedback":
                image_name = query.get("name", [""])[0]
                if not image_name:
                    self.send_json({"rating": None})
                    return
                log_dir = get_log_dir()
                history_file = os.path.join(log_dir, "generation_history.json")
                rating = None
                if os.path.exists(history_file):
                    try:
                        with open(history_file, "r", encoding="utf-8") as f:
                            history = json.load(f)
                        for h in history:
                            if h.get("image_name") == image_name or os.path.basename(h.get("output_image_path", "")) == image_name:
                                rating = h.get("rating")
                                break
                    except Exception:
                        pass
                self.send_json({"image_name": image_name, "rating": rating})
                return

            # 2. API: 태스크 진행 상태 확인 (고속 폴링)
            if path == "/api/task_status":
                task_id = query.get("task_id", [""])[0]
                if not task_id:
                    self.send_json({"error": "task_id required"}, 400)
                    return

                with TASK_STATUS_LOCK:
                    task_info = ACTIVE_TASKS.get(task_id)
                    if not task_info:
                        self.send_json({"status": "not_found", "error": "해당 작업을 찾을 수 없습니다."}, 404)
                        return

                    pos = get_queue_position(task_id)
                    status = task_info.get("status", "queued")
                    result = task_info.get("result")

                self.send_json({
                    "task_id": task_id,
                    "status": status,
                    "queue_position": pos,
                    "result": result
                })
                return

            # 3. API: 갤러리 이미지 목록 조회
            if path == "/api/gallery":
                out_dir = get_outputs_dir()
                items = []
                valid_exts = {".png", ".jpg", ".jpeg", ".webp", ".mp4"}
                try:
                    if os.path.exists(out_dir):
                        for root, _, files in os.walk(out_dir):
                            for fname in files:
                                ext = os.path.splitext(fname)[1].lower()
                                if ext in valid_exts:
                                    full_p = os.path.join(root, fname)
                                    rel_name = os.path.relpath(full_p, out_dir).replace(os.sep, "/")
                                    stat = os.stat(full_p)
                                    items.append({
                                        "name": rel_name,
                                        "size": stat.st_size,
                                        "mtime": stat.st_mtime,
                                        "is_video": ext == ".mp4",
                                        "url": f"/api/gallery/image?name={urllib.parse.quote(rel_name)}"
                                    })
                    items.sort(key=lambda x: x["mtime"], reverse=True)
                except Exception as e:
                    log_system_event("ERROR", "GALLERY_SCAN_ERROR", f"갤러리 목록 탐색 실패: {e}", exc=e)

                self.send_json({"count": len(items), "images": items})
                return

            # 4. API: 갤러리 이미지 바이너리 서빙
            if path == "/api/gallery/image":
                file_name = query.get("name", [""])[0]
                if not file_name:
                    self.send_error(400, "Image name required")
                    return
                out_dir = get_outputs_dir()
                norm_rel = os.path.normpath(file_name).lstrip("/" + os.sep)
                file_path = os.path.abspath(os.path.join(out_dir, norm_rel))
                if not file_path.startswith(out_dir) or not os.path.isfile(file_path):
                    self.send_error(404, "Image not found")
                    return

                mime_type, _ = mimetypes.guess_type(file_path)
                mime_type = mime_type or "application/octet-stream"
                try:
                    with open(file_path, "rb") as f:
                        content = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", mime_type)
                    self.send_header("Content-Length", str(len(content)))
                    self.send_header("Cache-Control", "public, max-age=3600")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(content)
                except Exception as e:
                    log_system_event("ERROR", "IMAGE_SERVE_ERROR", f"갤러리 이미지 읽기 실패 ({file_name}): {e}", exc=e)
                    self.send_error(500, f"Error reading file: {e}")
                return

            # 5. 정적 웹 자산 서빙
            clean_path = path.lstrip("/")
            if clean_path.startswith("static/"):
                clean_path = clean_path[len("static/"):]

            if not clean_path or clean_path == "index.html":
                file_path = os.path.join(STATIC_DIR, "index.html")
            else:
                file_path = os.path.join(STATIC_DIR, clean_path)

            if not os.path.exists(file_path):
                alt_path = os.path.join(BASE_DIR, path.lstrip("/"))
                if os.path.exists(alt_path) and os.path.isfile(alt_path):
                    file_path = alt_path

            if os.path.exists(file_path) and os.path.isfile(file_path):
                mime_type, _ = mimetypes.guess_type(file_path)
                mime_type = mime_type or "text/plain"
                if mime_type.startswith("text/") or mime_type in ["application/javascript", "application/json"]:
                    mime_type += "; charset=utf-8"
                try:
                    with open(file_path, "rb") as f:
                        content = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", mime_type)
                    self.send_header("Content-Length", str(len(content)))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(content)
                except Exception as e:
                    log_system_event("ERROR", "STATIC_FILE_ERROR", f"정적 파일 읽기 오류 ({clean_path}): {e}", exc=e)
                    self.send_error(500, f"Error reading static file: {e}")
            else:
                self.send_error(404, f"File Not Found: {path}")

        except Exception as e:
            log_system_event("ERROR", "HTTP_GET_UNHANDLED_EXCEPTION", f"GET 요청 처리 중 예외 발생 ({self.path}): {e}", exc=e)
            self.send_error(500, f"Internal Server Error: {e}")

    def do_POST(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path

            if path == "/api/config":
                content_len = int(self.headers.get("Content-Length", 0))
                raw_body = self.rfile.read(content_len)
                try:
                    body = json.loads(raw_body.decode("utf-8"))
                except Exception as e:
                    self.send_json({"success": False, "error": f"JSON 파싱 오류: {e}"}, 400)
                    return
                selected_model = body.get("selected_model", "")
                if not selected_model:
                    self.send_json({"success": False, "error": "selected_model 필드가 필요합니다."}, 400)
                    return
                try:
                    with open(CONFIG_PATH, "r", encoding="utf-8") as _cf:
                        cur_cfg = json.load(_cf)
                    cur_cfg["selected_model"] = selected_model
                    with open(CONFIG_PATH, "w", encoding="utf-8") as _cf:
                        json.dump(cur_cfg, _cf, ensure_ascii=False, indent=2)
                    log_system_event("INFO", "CONFIG_UPDATED", f"모델 설정 변경: {selected_model}")
                    self.send_json({"success": True, "selected_model": selected_model})
                except Exception as e:
                    log_system_event("ERROR", "CONFIG_WRITE_ERROR", f"설정 파일 저장 실패: {e}", exc=e)
                    self.send_json({"success": False, "error": str(e)}, 500)
                return

            # 평가 피드백 저장 API
            if path == "/api/feedback":
                content_len = int(self.headers.get("Content-Length", 0))
                raw_body = self.rfile.read(content_len)
                try:
                    body = json.loads(raw_body.decode("utf-8"))
                except Exception as e:
                    self.send_json({"success": False, "error": f"JSON 파싱 오류: {e}"}, 400)
                    return

                image_name = body.get("image_name", "").strip()
                rating_code = body.get("rating", "").strip().lower()

                if not image_name or not rating_code:
                    self.send_json({"success": False, "error": "image_name과 rating이 필요합니다."}, 400)
                    return

                if rating_code in ["like", "good", "thumbs_up"]:
                    rating_label = "👍 (마음에 들어요)"
                elif rating_code in ["dislike", "bad", "thumbs_down"]:
                    rating_label = "👎 (별로예요)"
                else:
                    rating_label = rating_code

                ok, msg = update_generation_feedback(image_name, rating_label)
                if ok:
                    self.send_json({"success": True, "image_name": image_name, "rating": rating_label, "message": msg})
                else:
                    self.send_json({"success": False, "error": msg}, 404)
                return

            if path == "/api/generate":
                content_len = int(self.headers.get("Content-Length", 0))
                raw_body = self.rfile.read(content_len)
                try:
                    payload = json.loads(raw_body.decode("utf-8"))
                except Exception as e:
                    self.send_json({"success": False, "error": f"JSON 파싱 오류: {e}"}, 400)
                    return

                prompt = payload.get("prompt", "").strip()
                if not prompt:
                    self.send_json({"success": False, "error": "포지티브 프롬프트를 입력해주세요."}, 400)
                    return

                task_id = str(uuid.uuid4())[:8]

                # ── 업로드한 이미지를 inputs 폴더에 영구 저장 ──
                image_b64 = payload.get("image")
                if image_b64:
                    try:
                        import base64
                        b64_data = image_b64.split(",", 1)[1] if "," in image_b64 else image_b64
                        img_bytes = base64.b64decode(b64_data)
                        now_tag = time.strftime("%Y%m%d_%H%M%S", time.localtime())
                        input_filename = f"input_{now_tag}_{task_id}.png"
                        input_save_path = os.path.join(get_inputs_dir(), input_filename)
                        with open(input_save_path, "wb") as f:
                            f.write(img_bytes)
                        payload["input_image_path"] = input_save_path
                        print(f"[*] 업로드 이미지 저장 완료: {input_save_path}")
                        log_system_event("INFO", "INPUT_IMAGE_SAVED", f"TaskID: {task_id} | 저장 경로: {input_save_path}")
                    except Exception as e:
                        log_system_event("ERROR", "INPUT_SAVE_ERROR", f"업로드 이미지 저장 실패 (Task {task_id}): {e}", exc=e)

                log_system_event("INFO", "TASK_QUEUED", f"TaskID: {task_id} | Prompt: '{prompt[:35]}...'")

                with TASK_STATUS_LOCK:
                    ACTIVE_TASKS[task_id] = {
                        "status": "queued",
                        "created_at": time.time(),
                        "payload": payload,
                        "result": None
                    }
                    TASK_QUEUE.put({"task_id": task_id, "payload": payload})
                    pos = get_queue_position(task_id)

                self.send_json({
                    "success": True,
                    "task_id": task_id,
                    "status": "queued",
                    "queue_position": pos,
                    "message": "대기열에 성공적으로 등록되었습니다."
                })
                return

            self.send_error(404, "Endpoint Not Found")

        except Exception as e:
            log_system_event("ERROR", "HTTP_POST_UNHANDLED_EXCEPTION", f"POST 요청 처리 중 예외 발생 ({self.path}): {e}", exc=e)
            self.send_json({"success": False, "error": f"서버 내부 오류: {e}"}, 500)

def get_all_host_ips():
    ips = set()
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127."):
                ips.add(ip)
    except Exception:
        pass
    try:
        for target in ["10.40.1.1", "10.41.0.1", "8.8.8.8"]:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                s.connect((target, 80))
                ip = s.getsockname()[0]
                if not ip.startswith("127."):
                    ips.add(ip)
            except Exception:
                pass
            finally:
                s.close()
    except Exception:
        pass
    return sorted(list(ips))

def run_server(port=None):
    cur_cfg = load_config()
    if port is None:
        port = cur_cfg.get("server_port", 8080)
    server_host = cur_cfg.get("server_host", "0.0.0.0")

    # 기본 디렉터리 생성 및 점검
    get_inputs_dir()
    get_outputs_dir()
    get_log_dir()
    get_sys_log_dir()

    # 워커 스레드 시작
    worker_thread = threading.Thread(target=queue_worker_loop, daemon=True)
    worker_thread.start()

    server_address = (server_host, port)
    httpd = ThreadingHTTPServer(server_address, FrontHandler)
    httpd.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    is_alive, active_url, status_text = check_or_detect_wan2gp()

    host_ips = get_all_host_ips()
    ip_lines = "\n".join([f"[*] 외부 접속 주소 (LAN): http://{ip}:{port}" for ip in host_ips])

    print("=" * 65)
    print("   [천재교육 CHUNJAE] Wan2GP FLUX.2 Klein 4B 프론트엔드 서버")
    print("   (ThreadingHTTPServer & 격리 프로세스 큐 시스템 가동 중)")
    print("=" * 65)
    print(f"[*] 바인딩 호스트: {server_host} (any 외부 접속 허용)")
    print(f"[*] 로컬 접속 주소: http://127.0.0.1:{port}")
    if ip_lines:
        print(ip_lines)
    print(f"[*] Wan2GP 백엔드: {'[온라인 정상 연결]' if is_alive else '[오프라인 대기 중]'} ({active_url})")
    print(f"[*] 워커 파이썬: {PYTHON_EXE}")
    print(f"[*] 입력 저장 폴더: {get_inputs_dir()}")
    print(f"[*] 출력 갤러리 경로: {get_outputs_dir()}")
    print(f"[*] 로그 저장 폴더: {get_log_dir()} (시스템 이벤트: {get_sys_log_dir()})")
    print(f"[*] 모델/해상도: Flux 2 Klein 4B ({cur_cfg.get('resolution', '720x720')}, {cur_cfg.get('num_inference_steps', 4)}스텝)")
    print("=" * 65)
    print("서버가 시작되었습니다. 브라우저에서 위 주소로 접속하세요. (종료: Ctrl+C)")

    # 시스템 시작 이벤트 로그 기록
    log_system_event("INFO", "SYSTEM_START", f"서버 가동 시작 (Port: {port}, Wan2GP URL: {active_url}, 상태: {status_text})")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
        log_system_event("INFO", "SYSTEM_STOP", "서버가 사용자에 의해 종료되었습니다.")
        httpd.server_close()
    except Exception as e:
        log_system_event("ERROR", "SERVER_CRASH", f"서버 비정상 종료: {e}", exc=e)
        httpd.server_close()

if __name__ == "__main__":
    cur_cfg = load_config()
    server_port = cur_cfg.get("server_port", 8080)
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        server_port = int(sys.argv[1])
    run_server(server_port)
