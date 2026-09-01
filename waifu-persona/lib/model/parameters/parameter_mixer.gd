extends Node

const Provider = preload("./parameter_value_provider.gd")

# Chaves que o Tracking (lipsync + olhar seguindo o mouse) deve sempre vencer,
# mesmo que outro provider (IdleMotion/Expression/OneShotMotion) tambem as tenha
# tocado nesse frame. O node "Tracking" nao e exclusivo do lipsync — o grafo de
# blueprint padrao (breathe/blink/face-tracking) tambem escreve nele — entao so
# damos prioridade a essas chaves especificas, nunca ao node inteiro.
const LIPSYNC_PRIORITY_KEYS = [
	"ParamMouthOpenY", "ParamMouthForm", "ParamEyeBallX", "ParamEyeBallY",
	# gltf/VRM equivalents (see lib/model/formats/gltf/model_strategy.gd) — a key here that
	# the active model's format doesn't expose is simply absent from tracking.values, so this
	# list is safe to keep as a superset across both formats.
	"aa", "Bone:leftEye:rotX", "Bone:leftEye:rotY", "Bone:rightEye:rotX", "Bone:rightEye:rotY",
]

var parameters : Dictionary :
	get():
		return get_parent().parameters

func _process(_delta: float) -> void:
	if get_parent() == null or not get_parent().is_initialized():
		return

	var values = {}
	for i in parameters:
		values[i] = parameters[i]["default"]

	var modified = {}
	for i in get_children():
		var provider: Provider = i
		provider.apply(modified)

	var tracking := get_node_or_null("Tracking")
	if tracking:
		for key in LIPSYNC_PRIORITY_KEYS:
			if tracking.values.has(key):
				modified[key] = tracking.values[key]

	values.merge(modified, true);

	get_parent().parameters = values
