extends Node

const SERVER_URL = "ws://localhost:41906"
const RECONNECT_DELAY = 5.0

const LIPSYNC_FRAME_SEC = 0.05          # tamanho da janela de analise do WAV
const LIPSYNC_RMS_GAIN = 2.8            # ganho aplicado ao RMS bruto (0..1) na extracao da curva
const LIPSYNC_ATTACK = 0.35             # suavizacao ao abrir a boca (menor = mais rapido)
const LIPSYNC_RELEASE = 0.55            # suavizacao ao fechar a boca (mais lento = mais natural)
const LIPSYNC_GAMMA = 0.6               # <1 realca volumes baixos (fala baixinho ainda move a boca)
const LIPSYNC_SILENCE_GATE = 0.015      # abaixo disso consideramos silencio (evita tremedeira)
const MOUTH_OPEN_SCALE = 1.0            # NAO subir sem reduzir o ganho acima — ParamMouthOpenY satura em 1.0
const MOUTH_FORM_RANGE = 0.55           # o quanto ParamMouthForm varia entre vogal/consoante

# "pulinho" cartoon enquanto fala — aplicado como offset na posicao do node do
# modelo (nao em parametro Cubism), entao soma por cima da idle/respiracao em vez
# de brigar/substituir ela
const BOUNCE_Y = 6.0     # amplitude do movimento vertical (px)
const BOUNCE_X = 3.0     # amplitude do balanco lateral (px)
const BOUNCE_FREQ_Y = 1.6    # bem mais lento que a boca — ritmo de corpo, nao de silaba
const BOUNCE_FREQ_X = 0.8
const BOUNCE_ENERGY_SMOOTHING = 0.9   # quanto maior, mais lento reage (ignora picos curtos)

# olhar seguindo o mouse (posicao global de tela, nao so dentro da janela)
const GAZE_RANGE_PX = 500.0    # distancia em px pra chegar no desvio maximo do olhar
const GAZE_SMOOTHING = 0.8     # suaviza o movimento do olho, evita tremer com o mouse

# clique nela toca uma animacao de reacao aleatoria (ja vem com o modelo)
const TAP_MOTIONS = [
	"tap_haru_06.motion3.json",
	"tap_haru_09.motion3.json",
	"tap_haru_20.motion3.json",
	"tap_haru_26.motion3.json",
	"tap_hiyori_04.motion3.json",
]

var _ws := WebSocketPeer.new()
var _ai_params: Dictionary = {}
var _smoothed_open: float = 0.0
var _smoothed_form: float = 0.0
var _smoothed_bounce_energy: float = 0.0
var _reconnect_timer: float = 0.0
var _connected: bool = false
var _current_speech_expression: String = ""
var _last_bounce: Vector2 = Vector2.ZERO
var _smoothed_gaze: Vector2 = Vector2.ZERO

# Fila de curvas pré-computadas (uma por frase recebida do backend). O daemon
# toca o audio de cada frase sequencialmente e por completo — se a gente
# trocasse a curva ativa assim que uma nova mensagem "tts" chegasse (em vez de
# enfileirar), a boca pularia pra frase seguinte antes do audio da frase
# anterior terminar de tocar de verdade.
var _curve_queue: Array[Dictionary] = []  # cada item: {"amp": Array[float], "form": Array[float], "text": String}
var _amp_pos: float = 0.0

class ParameterRelay extends Node:
	var source: Dictionary
	func parameters(_time: float = 0.0) -> Dictionary:
		return source

func _ready() -> void:
	Registry.add_parameter("VoiceVolume", Vector2(0, 1), 0.0)
	Registry.add_parameter("VoiceVolumePlusMouthOpen", Vector2(0, 1), 0.0)
	_inject_into_tracking_system.call_deferred()
	_connect()

func _inject_into_tracking_system() -> void:
	var ts := get_tree().get_first_node_in_group("system:tracking")
	if ts == null:
		push_warning("AIBridge: TrackingSystem não encontrado — boca não vai mover")
		return
	var relay := ParameterRelay.new()
	relay.source = _ai_params
	relay.name = "AIBridgeRelay"
	ts.add_child(relay)

func _connect() -> void:
	_ws.inbound_buffer_size = 64 * 1024 * 1024  # 64MB
	_ws.connect_to_url(SERVER_URL)

func _process(delta: float) -> void:
	_ws.poll()
	var state := _ws.get_ready_state()

	match state:
		WebSocketPeer.STATE_OPEN:
			_connected = true
			while _ws.get_available_packet_count() > 0:
				_handle(_ws.get_packet().get_string_from_utf8())

		WebSocketPeer.STATE_CLOSED:
			_connected = false
			_reconnect_timer += delta
			if _reconnect_timer >= RECONNECT_DELAY:
				_reconnect_timer = 0.0
				_ws = WebSocketPeer.new()
				_connect()

	_update_lipsync(delta)

## Amostra uma curva pré-computada com interpolação linear entre janelas,
## em vez de saltar de valor em valor a cada LIPSYNC_FRAME_SEC.
func _sample_curve(curve: Array[float], pos: float) -> float:
	if curve.is_empty():
		return 0.0
	var f := pos / LIPSYNC_FRAME_SEC
	var idx := int(f)
	if idx >= curve.size() - 1:
		return curve[curve.size() - 1]
	var frac := f - idx
	return lerpf(curve[idx], curve[idx + 1], frac)

func _update_lipsync(delta: float) -> void:
	var target_open := 0.0
	var target_form := 0.0

	if _curve_queue.size() > 0:
		var current: Dictionary = _curve_queue[0]
		var amp: Array[float] = current["amp"]
		var form: Array[float] = current["form"]
		target_open = _sample_curve(amp, _amp_pos)
		target_form = _sample_curve(form, _amp_pos)
		_amp_pos += delta

		var duration := amp.size() * LIPSYNC_FRAME_SEC
		if _amp_pos >= duration:
			_curve_queue.pop_front()
			_amp_pos = 0.0
			print("AIBridge DEBUG: frase terminou em t=%dms (duracao=%.2fs) — %d na fila" % [
				Time.get_ticks_msec(), duration, _curve_queue.size()
			])
			if _curve_queue.size() > 0:
				_on_phrase_started(_curve_queue[0])
			else:
				_on_all_phrases_done()

	if target_open < LIPSYNC_SILENCE_GATE:
		target_open = 0.0

	# ataque rapido ao abrir, soltura mais lenta ao fechar — fica mais organico
	var smoothing := LIPSYNC_ATTACK if target_open > _smoothed_open else LIPSYNC_RELEASE
	var rate := 1.0 - pow(smoothing, delta * 60.0)
	_smoothed_open = lerpf(_smoothed_open, target_open, rate)
	_smoothed_form = lerpf(_smoothed_form, target_form, rate)

	_ai_params["VoiceVolume"] = _smoothed_open

	var model = _get_model()
	if model and model.is_initialized():
		var tracking = model.mixer.get_node_or_null("Tracking")
		if tracking:
			var open_value := clampf(pow(_smoothed_open, LIPSYNC_GAMMA) * MOUTH_OPEN_SCALE, 0.0, 1.0)
			tracking.set("ParamMouthOpenY", open_value)
			tracking.set("aa", open_value) # gltf/VRM viseme equivalent, no-op on l2d models
			# forma da boca varia entre vogal aberta (~0) e consoante/sibilante (~MOUTH_FORM_RANGE),
			# só quando a boca esta de fato aberta o suficiente pra fazer diferenca visual
			var form_value := (_smoothed_form - 0.5) * 2.0 * MOUTH_FORM_RANGE * clampf(_smoothed_open * 3.0, 0.0, 1.0)
			tracking.set("ParamMouthForm", form_value)

			_update_gaze(tracking, delta)

		var bounce_rate := 1.0 - pow(BOUNCE_ENERGY_SMOOTHING, delta * 60.0)
		_smoothed_bounce_energy = lerpf(_smoothed_bounce_energy, _smoothed_open, bounce_rate)

		if _curve_queue.size() > 0:
			_update_talk_bounce(model, _smoothed_bounce_energy)
		else:
			_clear_talk_bounce(model)

## Balanco cartoon suave (cima/baixo + leve lateral) aplicado direto na posicao do
## node do modelo, proporcional a uma energia BEM suavizada (ignora picos de
## silaba) — como e um offset de posicao (nao um parametro Cubism), soma por cima
## de qualquer coisa que a idle/respiracao ja esteja fazendo, sem substituir nada.
func _update_talk_bounce(model, energy: float) -> void:
	var t := Time.get_ticks_msec() / 1000.0
	var bounce := Vector2(
		sin(t * BOUNCE_FREQ_X) * BOUNCE_X * energy,
		sin(t * BOUNCE_FREQ_Y) * BOUNCE_Y * energy
	)
	model.position += bounce - _last_bounce
	_last_bounce = bounce

## Olhos seguem o mouse enquanto ele estiver dentro da janela — fora dela, solta
## a chave pro olhar voltar a ser controlado pela idle/expression normalmente.
func _update_gaze(tracking, delta: float) -> void:
	var win_pos := DisplayServer.window_get_position()
	var win_size := DisplayServer.window_get_size()
	var mouse := Vector2(DisplayServer.mouse_get_position())
	var win_rect := Rect2(Vector2(win_pos), Vector2(win_size))

	if not win_rect.has_point(mouse):
		if tracking.values.has("ParamEyeBallX"):
			tracking.values.erase("ParamEyeBallX")
			tracking.values.erase("ParamEyeBallY")
			tracking.values.erase("Bone:leftEye:rotX")
			tracking.values.erase("Bone:leftEye:rotY")
			tracking.values.erase("Bone:rightEye:rotX")
			tracking.values.erase("Bone:rightEye:rotY")
		return

	var center := Vector2(win_pos) + Vector2(win_size) * 0.5
	var offset := mouse - center
	var target := Vector2(
		clampf(offset.x / GAZE_RANGE_PX, -1.0, 1.0),
		clampf(-offset.y / GAZE_RANGE_PX, -1.0, 1.0)
	)

	var rate := 1.0 - pow(GAZE_SMOOTHING, delta * 60.0)
	_smoothed_gaze = _smoothed_gaze.lerp(target, rate)

	tracking.set("ParamEyeBallX", _smoothed_gaze.x)
	tracking.set("ParamEyeBallY", _smoothed_gaze.y)
	tracking.set("Bone:leftEye:rotY", _smoothed_gaze.x) # gltf/VRM eye-bone equivalent, no-op if model has no eye bones
	tracking.set("Bone:leftEye:rotX", _smoothed_gaze.y)
	tracking.set("Bone:rightEye:rotY", _smoothed_gaze.x)
	tracking.set("Bone:rightEye:rotX", _smoothed_gaze.y)

## Clique nela toca uma reacao aleatoria (motion "tap_*" que ja vem com o modelo).
func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		_play_tap_reaction()

## Toca o tap com fade no peso do OneShotMotion (pausando a idle durante o tap e
## retomando depois) — sem isso o peso fica travado em 1.0 pra sempre apos o fim
## da animacao e ela nunca mais deixa a idle voltar a controlar os parametros.
func _play_tap_reaction() -> void:
	var model = _get_model()
	if not model:
		return
	var motion: String = TAP_MOTIONS[randi() % TAP_MOTIONS.size()]
	var os_player: AnimationPlayer = model.get_animation_player()
	var idle_player: AnimationPlayer = model.get_idle_animation_player()
	if not os_player.has_animation(motion):
		return

	os_player.stop()
	os_player.play(motion)

	var provider = model.mixer.get_node("OneShotMotion")
	var fade := 0.25
	var duration: float = os_player.get_animation(motion).length

	var t = provider.create_tween()
	t.tween_property(provider, "weight", 1.0, fade)
	t.tween_callback(idle_player.stop)
	t.tween_property(provider, "weight", 0.0, fade).set_delay(maxf(duration - fade, 0.0))
	t.tween_callback(idle_player.play)

func _clear_talk_bounce(model) -> void:
	if _last_bounce != Vector2.ZERO:
		model.position -= _last_bounce
		_last_bounce = Vector2.ZERO

func _handle(raw: String) -> void:
	var msg = JSON.parse_string(raw)
	if not msg is Dictionary:
		return

	match msg.get("type", ""):
		"tts":
			_load_amp_curve(msg.get("data", ""), msg.get("text", ""), msg.get("expression", ""))

		"parameters":
			var data: Dictionary = msg.get("data", {})
			for k in data:
				_ai_params[k] = float(data[k])

		"expression":
			var model = _get_model()
			if model:
				model.toggle_expression(
					msg.get("name", ""),
					msg.get("active", true),
					msg.get("duration", 0.5)
				)

		"motion":
			var model = _get_model()
			if model:
				model.get_animation_player().play(msg.get("name", ""))

		"clear_parameters":
			_ai_params.clear()

		"state":
			var model = _get_model()
			if model:
				var muted: bool = msg.get("muted", false)
				# muted -> expression de sono (olhos fechados + ZZZ) e idle mais calmo;
				# ouvindo -> volta pro idle normal
				model.toggle_expression("SleepingCustom.exp3.json", muted)
				var idle_anim: AnimationPlayer = model.get_idle_animation_player()
				# idle_hiyori_01 tem curvas cujo inicio/fim nao batem (salto feio no loop) —
				# idle_haru_1/idle_haru_2 sao seamless (primeiro/ultimo frame identicos)
				idle_anim.play("idle_haru_1.motion3.json" if muted else "idle_haru_2.motion3.json")

## Extrai, por janela de LIPSYNC_FRAME_SEC, o envelope RMS (volume) e uma
## taxa de cruzamento por zero normalizada (proxy barato de "brilho" espectral:
## vogais tendem a ser mais graves/periódicas, sibilantes/consoantes mais agudas)
## do WAV recebido, sem tocar nenhum áudio, e enfileira o resultado.
func _load_amp_curve(b64: String, text: String = "", expression: String = "") -> void:
	if b64.is_empty():
		return
	var bytes := Marshalls.base64_to_raw(b64)
	if bytes.size() < 44:
		return
	if bytes.slice(0, 4).get_string_from_ascii() != "RIFF":
		return

	var num_channels: int = bytes.decode_u16(22)
	var sample_rate: int  = bytes.decode_u32(24)
	var bits_per_sample: int = bytes.decode_u16(34)

	var data_offset := 12
	while data_offset + 8 < bytes.size():
		var chunk_id := bytes.slice(data_offset, data_offset + 4).get_string_from_ascii()
		var chunk_size := bytes.decode_u32(data_offset + 4)
		if chunk_id == "data":
			data_offset += 8
			break
		data_offset += 8 + chunk_size

	var samples_per_frame := int(sample_rate * LIPSYNC_FRAME_SEC)
	var bytes_per_sample := bits_per_sample / 8
	var frame_bytes := samples_per_frame * num_channels * bytes_per_sample
	if frame_bytes <= 0:
		return

	var amp_curve: Array[float] = []
	var form_curve: Array[float] = []
	var pos := data_offset
	var prev_sign := 0
	while pos + frame_bytes <= bytes.size():
		var sum_sq := 0.0
		var zero_crossings := 0
		var n := samples_per_frame * num_channels
		for i in range(n):
			var s := pos + i * bytes_per_sample
			var v: float
			if bits_per_sample == 16:
				v = float(bytes.decode_s16(s)) / 32768.0
			else:
				v = (float(bytes.decode_u8(s)) - 128.0) / 128.0
			sum_sq += v * v
			var sign: int = prev_sign
			if v > 0.01:
				sign = 1
			elif v < -0.01:
				sign = -1
			if sign != 0 and prev_sign != 0 and sign != prev_sign:
				zero_crossings += 1
			prev_sign = sign

		var rms := sqrt(sum_sq / maxf(float(n), 1.0))
		amp_curve.append(clampf(rms * LIPSYNC_RMS_GAIN, 0.0, 1.0))

		var zcr := float(zero_crossings) / maxf(float(n - 1), 1.0)
		# normaliza a faixa tipica de fala (grosso: vogais ~0.02-0.08, sibilantes ~0.15-0.35)
		form_curve.append(clampf(remap(zcr, 0.03, 0.25, 0.0, 1.0), 0.0, 1.0))

		pos += frame_bytes

	if amp_curve.is_empty():
		return

	var was_empty := _curve_queue.is_empty()
	var entry := {"amp": amp_curve, "form": form_curve, "text": text, "expression": expression}
	_curve_queue.append(entry)
	print("AIBridge DEBUG: frase enfileirada em t=%dms — duracao=%.2fs, %d na fila" % [
		Time.get_ticks_msec(), amp_curve.size() * LIPSYNC_FRAME_SEC, _curve_queue.size()
	])

	if was_empty:
		_on_phrase_started(entry)

## Chamado quando uma frase vira a que esta tocando agora: mostra a legenda dela
## e troca a expressao do rosto (se a frase tiver uma tag de emocao mapeada).
func _on_phrase_started(entry: Dictionary) -> void:
	var text: String = entry.get("text", "")
	var subs = _get_subtitles()
	if subs:
		if text.is_empty():
			subs.hide_text()
		else:
			var amp: Array[float] = entry["amp"]
			var duration: float = amp.size() * LIPSYNC_FRAME_SEC
			subs.show_text(text, duration)

	_apply_speech_expression(entry.get("expression", ""))

## Chamado quando a fila de fala inteira acaba: some a legenda e volta a
## expressao neutra (se alguma tinha sido ativada por uma frase).
func _on_all_phrases_done() -> void:
	var subs = _get_subtitles()
	if subs:
		subs.hide_text()
	_apply_speech_expression("")

func _apply_speech_expression(expression_name: String) -> void:
	if expression_name == _current_speech_expression:
		return
	var model = _get_model()
	if not model:
		return
	if not _current_speech_expression.is_empty():
		model.toggle_expression(_current_speech_expression, false, 0.4)
	_current_speech_expression = expression_name
	if not expression_name.is_empty():
		model.toggle_expression(expression_name, true, 0.4)

func _get_subtitles():
	return get_tree().get_first_node_in_group("system:subtitles")

func _get_model():
	var stage := get_tree().get_first_node_in_group("system:stage")
	return stage.active_model if stage else null
