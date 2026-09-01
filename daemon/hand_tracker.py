#!/usr/bin/env python3
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL_PATH = os.path.join(HERE, 'models', 'hand_landmarker.task')

WRIST = 0
THUMB_MCP, THUMB_TIP = 2, 4
INDEX_MCP, INDEX_PIP, INDEX_TIP = 5, 6, 8
MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP = 9, 10, 12
RING_MCP, RING_PIP, RING_TIP = 13, 14, 16
PINKY_MCP, PINKY_PIP, PINKY_TIP = 17, 18, 20

YAW_GAIN = 2.2
PITCH_GAIN = 2.2
MAX_YAW = 1.0
MAX_PITCH = 0.55

SMOOTHING_ALPHA = 0.35

PINCH_ON = 0.55
PINCH_OFF = 0.85

GESTURE_DEBOUNCE_FRAMES = 3

TARGET_FPS = 18


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _dist(a, b):
    return math.hypot(a.x - b.x, a.y - b.y)


def _finger_extended(landmarks, tip_i, pip_i, factor=1.3):
    wrist = landmarks[WRIST]
    return _dist(landmarks[tip_i], wrist) > _dist(landmarks[pip_i], wrist) * factor


def _finger_curled(landmarks, tip_i, pip_i, factor=1.0):
    wrist = landmarks[WRIST]
    return _dist(landmarks[tip_i], wrist) < _dist(landmarks[pip_i], wrist) * factor


def _angle_deg(v1, v2):
    dot = v1[0] * v2[0] + v1[1] * v2[1]
    m1, m2 = math.hypot(*v1), math.hypot(*v2)
    if m1 < 1e-6 or m2 < 1e-6:
        return 0.0
    cos_a = clamp(dot / (m1 * m2), -1.0, 1.0)
    return math.degrees(math.acos(cos_a))


def _is_l_shape(landmarks, sustaining=False):
    if not (_finger_extended(landmarks, INDEX_TIP, INDEX_PIP)
            and _finger_curled(landmarks, MIDDLE_TIP, MIDDLE_PIP)
            and _finger_curled(landmarks, RING_TIP, RING_PIP)
            and _finger_curled(landmarks, PINKY_TIP, PINKY_PIP)):
        return False
    if sustaining:
        return True
    wrist = landmarks[WRIST]
    thumb_extended = _dist(landmarks[THUMB_TIP], wrist) > _dist(landmarks[THUMB_MCP], wrist) * 1.15
    if not thumb_extended:
        return False
    v_thumb = (landmarks[THUMB_TIP].x - landmarks[THUMB_MCP].x, landmarks[THUMB_TIP].y - landmarks[THUMB_MCP].y)
    v_index = (landmarks[INDEX_TIP].x - landmarks[INDEX_MCP].x, landmarks[INDEX_TIP].y - landmarks[INDEX_MCP].y)
    angle = _angle_deg(v_thumb, v_index)
    return 50.0 <= angle <= 130.0


def _is_fist(landmarks):
    return (_finger_curled(landmarks, INDEX_TIP, INDEX_PIP)
            and _finger_curled(landmarks, MIDDLE_TIP, MIDDLE_PIP)
            and _finger_curled(landmarks, RING_TIP, RING_PIP)
            and _finger_curled(landmarks, PINKY_TIP, PINKY_PIP))


def main():
    model_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL_PATH
    camera_index = int(sys.argv[2]) if len(sys.argv) > 2 else 0

    if not os.path.exists(model_path):
        print(f'hand_tracker: model not found at {model_path}', file=sys.stderr, flush=True)
        sys.exit(1)

    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import vision, BaseOptions

    landmarker = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=1,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    ))

    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        print(f'hand_tracker: could not open camera {camera_index}', file=sys.stderr, flush=True)
        sys.exit(1)

    smoothed_palm_x, smoothed_palm_y = None, None
    smoothed_pinch_x, smoothed_pinch_y = None, None
    pinching = False
    mode = 'none'
    candidate_mode = 'none'
    candidate_streak = 0
    fist = False
    fist_candidate = False
    fist_streak = 0
    frame_interval = 1.0 / TARGET_FPS
    start = time.monotonic()

    try:
        while True:
            loop_start = time.monotonic()
            ok, frame = cap.read()
            if not ok:
                print(json.dumps({'present': False}), flush=True)
                time.sleep(frame_interval)
                continue

            try:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                timestamp_ms = int((time.monotonic() - start) * 1000)
                result = landmarker.detect_for_video(mp_image, timestamp_ms)
            except Exception:
                print(json.dumps({'present': False}), flush=True)
                time.sleep(frame_interval)
                continue

            if not result.hand_landmarks:
                smoothed_palm_x = smoothed_palm_y = None
                smoothed_pinch_x = smoothed_pinch_y = None
                pinching = False
                mode, candidate_mode, candidate_streak = 'none', 'none', 0
                fist, fist_candidate, fist_streak = False, False, 0
                print(json.dumps({'present': False}), flush=True)
            else:
                lm = result.hand_landmarks[0]

                palm_size = max(1e-4, _dist(lm[WRIST], lm[MIDDLE_MCP]))
                raw_palm_x = (lm[WRIST].x + lm[MIDDLE_MCP].x) / 2
                raw_palm_y = (lm[WRIST].y + lm[MIDDLE_MCP].y) / 2
                mirrored_palm_x = 1.0 - raw_palm_x
                if smoothed_palm_x is None:
                    smoothed_palm_x, smoothed_palm_y = mirrored_palm_x, raw_palm_y
                else:
                    smoothed_palm_x += (mirrored_palm_x - smoothed_palm_x) * SMOOTHING_ALPHA
                    smoothed_palm_y += (raw_palm_y - smoothed_palm_y) * SMOOTHING_ALPHA
                ry = clamp((smoothed_palm_x - 0.5) * YAW_GAIN, -MAX_YAW, MAX_YAW)
                rx = clamp((smoothed_palm_y - 0.5) * PITCH_GAIN, -MAX_PITCH, MAX_PITCH)

                raw_pinch_x = (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2
                raw_pinch_y = (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2
                mirrored_pinch_x = 1.0 - raw_pinch_x
                if smoothed_pinch_x is None:
                    smoothed_pinch_x, smoothed_pinch_y = mirrored_pinch_x, raw_pinch_y
                else:
                    smoothed_pinch_x += (mirrored_pinch_x - smoothed_pinch_x) * SMOOTHING_ALPHA
                    smoothed_pinch_y += (raw_pinch_y - smoothed_pinch_y) * SMOOTHING_ALPHA

                pinch_ratio = _dist(lm[THUMB_TIP], lm[INDEX_TIP]) / palm_size
                pinch_candidate = (not _is_fist(lm)) and (
                    (pinch_ratio < PINCH_ON) if not pinching else (pinch_ratio < PINCH_OFF)
                )
                pinching = pinch_candidate

                candidate = 'rotate' if (_is_l_shape(lm, sustaining=(mode == 'rotate')) and not pinching) else 'none'
                if candidate == candidate_mode:
                    candidate_streak += 1
                else:
                    candidate_mode, candidate_streak = candidate, 1
                if candidate_streak >= GESTURE_DEBOUNCE_FRAMES:
                    mode = candidate_mode

                fist_now = _is_fist(lm) and not pinching
                if fist_now == fist_candidate:
                    fist_streak += 1
                else:
                    fist_candidate, fist_streak = fist_now, 1
                if fist_streak >= GESTURE_DEBOUNCE_FRAMES:
                    fist = fist_candidate

                landmarks_out = [[round(1.0 - p.x, 4), round(p.y, 4)] for p in lm]

                print(json.dumps({
                    'present': True,
                    'x': smoothed_pinch_x,
                    'y': smoothed_pinch_y,
                    'pinch': pinching,
                    'mode': mode,
                    'fist': fist,
                    'rx': rx,
                    'ry': ry,
                    'landmarks': landmarks_out,
                }), flush=True)

            elapsed = time.monotonic() - loop_start
            if elapsed < frame_interval:
                time.sleep(frame_interval - elapsed)
    except KeyboardInterrupt:
        pass
    finally:
        cap.release()


if __name__ == '__main__':
    main()
