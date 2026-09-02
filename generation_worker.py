#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
독립 이미지 생성 실행기
- stdout 파이프 버퍼 블로킹 100% 방지 (view_api 제거, 빠른 직진 실행)
- 7단계 Gradio 이벤트 체인 즉시 순차 실행
- 결과 JSON을 stdout 및 파일에 안전하게 출력
- inputs 영구 보관 지원 및 소요 시간/경로 반환
"""

import os
import sys
import json
import time
import base64
import tempfile
import urllib.parse
import io

# Wan2GP 경로 설정 (wan.git 또는 wan2gp-amd.git)
WAN_APP_DIR_CANDIDATES = [
    r"C:\pinokio\api\wan.git\app",
    r"C:\pinokio\api\wan2gp-amd.git\app"
]
WAN_APP_DIR = next((p for p in WAN_APP_DIR_CANDIDATES if os.path.exists(p)), WAN_APP_DIR_CANDIDATES[0])
WAN_SITE_PACKAGES = os.path.join(WAN_APP_DIR, "venv", "Lib", "site-packages")
WAN_CONFIG_PATH = os.path.join(WAN_APP_DIR, "wgp_config.json")

if os.path.exists(WAN_SITE_PACKAGES) and WAN_SITE_PACKAGES not in sys.path:
    sys.path.insert(0, WAN_SITE_PACKAGES)

try:
    if sys.stdout.encoding != 'utf-8':
        sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def get_wan_outputs_dir(task_out_dir):
    if 'WAN_CONFIG_PATH' in dir() and os.path.exists(WAN_CONFIG_PATH):
        try:
            with open(WAN_CONFIG_PATH, "r", encoding="utf-8") as f:
                wgp_cfg = json.load(f)
            for key in ("image_save_path", "save_path"):
                sp = wgp_cfg.get(key, "")
                if sp:
                    if not os.path.isabs(sp):
                        sp = os.path.join(WAN_APP_DIR, sp)
                    if os.path.exists(sp):
                        return os.path.abspath(sp)
        except Exception as e:
            print(f"[!] wgp_config.json 읽기 실패: {e}")
    amd_out = os.path.join(WAN_APP_DIR, "outputs")
    if os.path.exists(amd_out):
        return amd_out
    if os.path.exists(task_out_dir):
        return task_out_dir
    os.makedirs(task_out_dir, exist_ok=True)
    return task_out_dir


def get_current_model_type():
    cfg_path = globals().get("WAN_CONFIG_PATH", "")
    if cfg_path and os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                wgp_cfg = json.load(f)
            model_type = wgp_cfg.get("last_model_type", "flux2_klein_4b")
            print(f"[*] 현재 서버 모델: {model_type} (wgp_config.json 기준)")
            return model_type
        except Exception as e:
            print(f"[!] wgp_config.json 모델 읽기 실패: {e}")
    return "flux2_klein_4b"


def extract_image_from_gradio_result(result):
    if result is None:
        return None
    if isinstance(result, (list, tuple)):
        for item in result:
            name = extract_image_from_gradio_result(item)
            if name:
                return name
    if isinstance(result, dict):
        for key in ("path", "orig_name", "name"):
            val = result.get(key, "")
            if val and os.path.splitext(val)[1].lower() in [".png", ".jpg", ".jpeg", ".webp"]:
                return os.path.basename(val)
    if isinstance(result, str):
        ext = os.path.splitext(result)[1].lower()
        if ext in [".png", ".jpg", ".jpeg", ".webp"]:
            return os.path.basename(result)
    return None


# 해상도 값 → 카테고리(그룹) 매핑 테이블
# Wan2GP shared/resolutions.py의 GROUP_THRESHOLDS 기준
_RESOLUTION_TO_GROUP = {
    # 256p
    "448x256": "256p", "256x448": "256p", "320x320": "256p",
    # 320p
    "576x320": "320p", "320x576": "320p", "448x448": "320p",
    # 384p
    "672x384": "384p", "384x672": "384p", "512x512": "384p",
    # 480p
    "832x624": "480p", "624x832": "480p", "720x720": "480p",
    "832x480": "480p", "480x832": "480p",
    # 540p
    "960x544": "540p", "544x960": "540p",
    # 720p
    "1024x1024": "720p", "1280x720": "720p", "720x1280": "720p",
    "1600x400": "720p", "1280x544": "720p", "544x1280": "720p",
    "1104x832": "720p", "832x1104": "720p", "960x960": "720p",
    # 1080p
    "1920x1088": "1080p", "1088x1920": "1080p", "1440x1440": "1080p",
    "1536x1024": "1080p", "1024x1536": "1080p", "1920x832": "1080p",
    "832x1920": "1080p", "2048x768": "1080p", "1024x1792": "1080p",
    "1088x1088": "1080p",
}

def get_resolution_group(resolution_str: str) -> str:
    """해상도 문자열에서 Wan2GP 카테고리 그룹을 반환합니다. 픽셀 수 기반 자동 분류 포함."""
    resolution_str = resolution_str.strip().lower().replace(" ", "")
    # 직접 매핑 확인
    group = _RESOLUTION_TO_GROUP.get(resolution_str)
    if group:
        return group
    # 대소문자 무관 재탐색
    for k, v in _RESOLUTION_TO_GROUP.items():
        if k.lower() == resolution_str:
            return v
    # 픽셀 수 기반 자동 분류
    GROUP_THRESHOLDS_ORDERED = [
        ("256p",  448 * 256),
        ("320p",  448 * 448),
        ("384p",  512 * 512),
        ("480p",  832 * 624),
        ("540p",  960 * 544),
        ("720p",  1024 * 1024),
        ("1080p", 1920 * 1088),
        ("1440p", 2560 * 1440),
        ("2160p", 3840 * 2176),
    ]
    try:
        sep = "x" if "x" in resolution_str else "X"
        w, h = resolution_str.split(sep)
        pixels = int(w) * int(h)
        for group_name, threshold in GROUP_THRESHOLDS_ORDERED:
            if pixels <= threshold:
                return group_name
    except Exception:
        pass
    return "480p"  # 기본 그룹


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "작업 파라미터 파일 경로 누락"}, ensure_ascii=False))
        sys.exit(1)

    task_file = sys.argv[1]
    with open(task_file, "r", encoding="utf-8") as f:
        task_data = json.load(f)

    wan2gp_url = task_data.get("wan2gp_url", "http://127.0.0.1:42003").rstrip("/")
    task_out_dir = task_data.get("outputs_path", os.path.join(WAN_APP_DIR, "outputs"))
    mode = task_data.get("mode", "t2i")
    prompt = task_data.get("prompt", "")
    negative_prompt = task_data.get("negative_prompt", "")
    seed = task_data.get("seed", -1)
    image_b64 = task_data.get("image", None)
    mask_b64 = task_data.get("mask", None)
    input_image_path = task_data.get("input_image_path", None)
    target_model = task_data.get("target_model", "") or get_current_model_type()

    # config.json의 "Enhance Prompt via LLM" 값을 Gradio API 파라미터 값으로 변환
    _ENHANCE_PROMPT_MAP = {
        "Based on Text Prompt Content": "T",
        "Based on both Text Prompt and Images Prompts Content": "TI",
        "Based on both Text Prompt and Images Prompts Content (Start Image / First Reference Image)": "TI",
        "Disabled": "",
        "": "",
    }
    _enhance_label = task_data.get("prompt_enhancer_label", "")
    prompt_enhancer_value = _ENHANCE_PROMPT_MAP.get(_enhance_label, "")
    if _enhance_label and _enhance_label not in _ENHANCE_PROMPT_MAP:
        print(f"[!] 알 수 없는 'Enhance Prompt via LLM' 설정값: {_enhance_label!r} (비활성으로 처리)")

    # wan2gp가 실제로 저장하는 폴더 결정
    out_dir = get_wan_outputs_dir(task_out_dir)
    print(f"[*] 이미지 감지 폴더: {out_dir}")

    os.makedirs(out_dir, exist_ok=True)
    before_files = set(os.listdir(out_dir)) if os.path.exists(out_dir) else set()
    snapshot_time = time.time()

    is_external_input = False
    temp_img_path = None
    temp_mask_path = None

    if input_image_path and os.path.exists(input_image_path):
        temp_img_path = input_image_path
        is_external_input = True
    elif mode in ["inpaint", "t2i"] and image_b64:
        if "," in image_b64:
            image_b64 = image_b64.split(",", 1)[1]
        tfile = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        tfile.write(base64.b64decode(image_b64))
        tfile.close()
        temp_img_path = tfile.name

    if mode == "inpaint" and mask_b64:
        if "," in mask_b64:
            mask_b64 = mask_b64.split(",", 1)[1]
        tfile = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        tfile.write(base64.b64decode(mask_b64))
        tfile.close()
        temp_mask_path = tfile.name

    try:
        from gradio_client import Client, handle_file

        print(f"[*] Gradio Client 연결 시작: {wan2gp_url}")

        # view_api의 대량 콘솔 출력을 억제하여 파이프 블로킹 원천 차단
        old_stdout = sys.stdout
        sys.stdout = io.StringIO()
        try:
            client = Client(wan2gp_url, verbose=False)
            api_info = client.view_api(return_format='dict')
            save_inputs_meta = api_info['named_endpoints']['/save_inputs_16']
            params = {}
            for p in save_inputs_meta['parameters']:
                params[p['parameter_name']] = p.get('parameter_default', None)
        finally:
            sys.stdout = old_stdout

        print(f"[+] Client 및 파라미터 로드 완료!")

        params['prompt'] = prompt
        params['negative_prompt'] = negative_prompt or "low quality, blurry, distorted"
        
        # config.json에서 전달된 설정값 적용 (동적 반영)
        params['resolution'] = str(task_data.get("resolution", "720x720"))
        params['num_inference_steps'] = int(task_data.get("num_inference_steps", 4))
        params['guidance_scale'] = float(task_data.get("guidance_scale", 1.0))
        params['batch_size'] = 1
        params['seed'] = seed if (seed is not None and seed >= 0) else -1
        params['target'] = "state"
        
        print(f"[*] 설정값 적용: 모델={target_model}, 해상도={params['resolution']}, 스텝={params['num_inference_steps']}, CFG={params['guidance_scale']}")

        # Enhance Prompt via LLM 설정 적용
        params['prompt_enhancer'] = prompt_enhancer_value
        if prompt_enhancer_value:
            print(f"[*] Enhance Prompt via LLM: {_enhance_label!r} → API 값={prompt_enhancer_value!r}")

        # NAG 설정 적용
        if "NAG_scale" in task_data and task_data["NAG_scale"] is not None:
            if not negative_prompt.strip():
                params['NAG_scale'] = 1.0
                print(f"[*] 네거티브 프롬프트 미입력: NAG_scale 강제 1.0 적용")
            else:
                params['NAG_scale'] = task_data["NAG_scale"]
                print(f"[*] NAG_scale 적용: {params['NAG_scale']}")
        if "NAG_tau" in task_data and task_data["NAG_tau"] is not None:
            params['NAG_tau'] = task_data["NAG_tau"]
            print(f"[*] NAG_tau 적용: {params['NAG_tau']}")
        if "NAG_alpha" in task_data and task_data["NAG_alpha"] is not None:
            params['NAG_alpha'] = task_data["NAG_alpha"]
            print(f"[*] NAG_alpha 적용: {params['NAG_alpha']}")

        if mode == "inpaint" and temp_img_path:
            params['image_mode'] = 2
            params['image_prompt_type'] = ""
            params['video_prompt_type'] = "VA"

            if temp_mask_path:
                params['image_mask_guide'] = {
                    "background": handle_file(temp_img_path),
                    "layers": [handle_file(temp_mask_path)],
                    "composite": None
                }
            else:
                params['image_mask_guide'] = {
                    "background": handle_file(temp_img_path),
                    "layers": [],
                    "composite": None
                }

            params['image_guide'] = None
            params['image_mask'] = None
            params['image_start'] = []
            params['image_refs'] = []
            params['denoising_strength'] = 1.0

            # config.json에서 전달된 인페인팅 설정값 적용
            masking_strength = float(task_data.get("masking_strength", 1.0))
            mask_expand_shrink = int(task_data.get("mask_expand_shrink", 0))
            params['masking_strength'] = masking_strength
            if 'expand_mask' in params:
                params['expand_mask'] = mask_expand_shrink
            print(f"[*] 인페인팅 설정 적용: masking_strength={masking_strength}, mask_expand_shrink={mask_expand_shrink}")
        elif mode == "t2i" and temp_img_path:
            print(f"[*] [T2I] 레퍼런스 이미지 조건부 생성 모드 가동 (FLUX.2 Native Reference): {temp_img_path}")
            params['image_mode'] = 1
            params['image_prompt_type'] = ""
            params['video_prompt_type'] = "KI"
            params['image_refs'] = [{'image': handle_file(temp_img_path)}]
            params['image_guide'] = None
            params['image_mask'] = None
            params['image_mask_guide'] = None
            params['image_start'] = []
        else:
            params['image_mode'] = 1
            params['image_prompt_type'] = ""
            params['video_prompt_type'] = ""
            params['image_guide'] = None
            params['image_mask'] = None
            params['image_mask_guide'] = None
            params['image_refs'] = []
            params['image_start'] = []

        # ── 7단계 Gradio 이벤트 체인 순차 실행 ──
        print(f"[*] [0/7] 모델 전환 확인 중 ({target_model})...")
        try:
            client.predict(model_type=target_model, api_name="/change_model_from_target")
            client.predict(api_name="/refresh_model_dropdowns")
        except Exception as e:
            print(f"[!] 모델 전환 API 오류 (무시하고 계속): {e}")

        print(f"[*] [1/7] init_generate 실행 중...")
        client.predict(input_file_list=None, last_choice=-1, audio_files_paths="[]", audio_file_selected=-1, api_name="/init_generate")

        print(f"[*] [2/7] validate_wizard_prompt_16 실행 중...")
        client.predict(
            wizard_prompt_activated="off",
            wizard_variables_names="",
            prompt=prompt,
            wizard_prompt="",
            param_5="", param_6="", param_7="", param_8="", param_9="", param_10="", param_11="", param_12="", param_13="", param_14="",
            api_name="/validate_wizard_prompt_16"
        )

        # [2.5/7] 해상도 카테고리(그룹) 전환 → save_inputs_16의 resolution 드롭다운 선택지를 올바르게 갱신
        resolution_val = str(params.get('resolution', '720x720'))
        resolution_group = get_resolution_group(resolution_val)
        print(f"[*] [2.5/7] 해상도 그룹 전환 중: {resolution_group} ({resolution_val})...")
        try:
            client.predict(selected_group=resolution_group, api_name="/change_resolution_group")
            client.predict(selected_group=resolution_group, api_name="/change_resolution_group_1")
        except Exception as e:
            print(f"[!] 해상도 그룹 전환 오류 (무시하고 계속): {e}")

        print(f"[*] [3/7] save_inputs_16 실행 중 ({resolution_val}, {params['num_inference_steps']}스텝, CFG {params['guidance_scale']})...")
        client.predict(api_name="/save_inputs_16", **params)

        print(f"[*] [4/7] process_prompt_and_add_tasks_1 실행 중 (model: {target_model})...")
        client.predict(current_gallery_tab=0, model_choice=target_model, api_name="/process_prompt_and_add_tasks_1")

        print(f"[*] [5/7] prepare_generate_media 실행 중...")
        client.predict(api_name="/prepare_generate_media")

        print(f"[*] [6/7] process_tasks ★ GPU 모델 추론 가동 중 ({target_model})...")
        client.predict(api_name="/process_tasks")

        print(f"[*] [7/7] finalize_generation 마무리 중...")
        finalize_result = client.predict(api_name="/finalize_generation")
        print(f"[*] finalize 응답: {finalize_result}")

        # ── 이미지 파일 감지 (3단계) ──

        # 1차: Gradio finalize_generation 응답에서 직접 파일명 추출
        new_image_name = extract_image_from_gradio_result(finalize_result)
        if new_image_name:
            print(f"[★] Gradio 응답에서 파일명 추출: {new_image_name}")

        # 2차: 파일시스템 diff 기반 감지 (최대 30초)
        if not new_image_name:
            print(f"[*] 파일시스템에서 새 이미지 감지 중 (최대 30초)...")
            valid_exts = {".png", ".jpg", ".jpeg", ".webp"}
            for i in range(38):
                time.sleep(0.8)
                if os.path.exists(out_dir):
                    current_files = set(os.listdir(out_dir))
                    diff = current_files - before_files
                    valid_new = [f for f in diff if os.path.splitext(f)[1].lower() in valid_exts]
                    if valid_new:
                        valid_new.sort(key=lambda x: os.path.getmtime(os.path.join(out_dir, x)), reverse=True)
                        new_image_name = valid_new[0]
                        print(f"[★] 파일시스템 diff 감지: {new_image_name}")
                        break

        # 3차: snapshot_time 이후 수정된 가장 최신 파일 탐색
        if not new_image_name:
            print(f"[*] 타임스탬프 기반으로 최신 파일 탐색 중...")
            if os.path.exists(out_dir):
                valid_exts = {".png", ".jpg", ".jpeg", ".webp"}
                all_files = [
                    f for f in os.listdir(out_dir)
                    if os.path.splitext(f)[1].lower() in valid_exts
                    and os.path.getmtime(os.path.join(out_dir, f)) >= snapshot_time - 5
                ]
                if all_files:
                    all_files.sort(key=lambda x: os.path.getmtime(os.path.join(out_dir, x)), reverse=True)
                    new_image_name = all_files[0]
                    print(f"[★] 타임스탬프 기반 감지: {new_image_name}")

        # 임시 파일 정리 (외부 input 파일은 삭제하지 않음)
        if temp_img_path and not is_external_input and os.path.exists(temp_img_path):
            try: os.remove(temp_img_path)
            except Exception: pass
        if temp_mask_path and os.path.exists(temp_mask_path):
            try: os.remove(temp_mask_path)
            except Exception: pass

        if new_image_name:
            full_out_path = os.path.join(out_dir, new_image_name)
            elapsed_sec = round(time.time() - snapshot_time, 1)
            # 이미지 파일 생성시간(mtime) 기준으로 정밀 소요시간 계산
            try:
                img_mtime = os.path.getmtime(full_out_path)
                if img_mtime >= snapshot_time:
                    elapsed_sec = round(img_mtime - snapshot_time, 1)
            except Exception:
                pass

            print(f"[★ 성공 ★] 생성된 이미지 파일: {new_image_name} (소요시간: {elapsed_sec}초)")
            result = {
                "success": True,
                "message": "이미지가 성공적으로 생성되었습니다.",
                "image_name": new_image_name,
                "image_path": full_out_path,
                "elapsed_time": f"{elapsed_sec}초",
                "input_image_path": input_image_path or "없음",
                "image_url": f"/api/gallery/image?name={urllib.parse.quote(new_image_name)}"
            }
        else:
            result = {"success": False, "error": "이미지 파일 감지 실패 (wan2gp outputs 폴더를 확인하세요)"}

    except Exception as e:
        print(f"[!] 생성 실행 오류: {e}")
        import traceback
        traceback.print_exc()
        result = {"success": False, "error": str(e)}

    result_file = task_file + ".result"
    with open(result_file, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)

    print("__RESULT_JSON__" + json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
