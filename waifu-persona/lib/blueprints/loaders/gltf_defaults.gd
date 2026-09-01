extends "./blueprint_loader.gd"

const DEFAULT_BINDINGS = {
	"FaceAngleX": [
		{ "name": "Bone:head:rotX", "value_range": Vector2(-30, 30), "smoothing": 15 },
		{ "name": "Bone:neck:rotX", "value_range": Vector2(-15, 15), "smoothing": 20 },
		{ "name": "Bone:spine:rotX", "value_range": Vector2(-8, 8), "smoothing": 30 },
	],
	"FaceAngleY": [
		{ "name": "Bone:head:rotY", "value_range": Vector2(-45, 45), "smoothing": 15 },
		{ "name": "Bone:neck:rotY", "value_range": Vector2(-20, 20), "smoothing": 20 },
	],
	"FaceAngleZ": [
		{ "name": "Bone:head:rotZ", "value_range": Vector2(-20, 20), "smoothing": 30 },
		{ "name": "Bone:neck:rotZ", "value_range": Vector2(-10, 10), "smoothing": 20 },
	],
	"EyeRightX": [
		{ "name": "Bone:rightEye:rotY", "value_range": Vector2(-20, 20), "smoothing": 8 },
		{ "name": "Bone:leftEye:rotY", "value_range": Vector2(-20, 20), "smoothing": 8 },
	],
	"EyeRightY": [
		{ "name": "Bone:rightEye:rotX", "value_range": Vector2(-15, 15), "smoothing": 8 },
		{ "name": "Bone:leftEye:rotX", "value_range": Vector2(-15, 15), "smoothing": 8 },
	],
	"EyeOpenLeft": [
		{ "name": "blinkLeft", "value_range": Vector2(1, 0), "smoothing": 10 },
	],
	"EyeOpenRight": [
		{ "name": "blinkRight", "value_range": Vector2(1, 0), "smoothing": 10 },
	],
	"MouthSmile": [
		{ "name": "happy", "value_range": Vector2(0, 1), "smoothing": 10 },
	],
	"VoiceVolumePlusMouthOpen": [
		{ "name": "aa", "value_range": Vector2(0, 1) },
	],
	"VoiceA": [{ "name": "aa", "value_range": Vector2(0, 1) }],
	"VoiceI": [{ "name": "ih", "value_range": Vector2(0, 1) }],
	"VoiceU": [{ "name": "ou", "value_range": Vector2(0, 1) }],
	"VoiceE": [{ "name": "ee", "value_range": Vector2(0, 1) }],
	"VoiceO": [{ "name": "oh", "value_range": Vector2(0, 1) }],
}

const spacing = 30

## given a glTF/VRM model, create a blueprint using a standard tracking-parameter binding,
## analogous to l2d_defaults.gd but targeting blend-shape/bone parameter names instead of
## Live2D ParamXXX names.
func load_graph(model: VtModel) -> Array[Blueprint]:
	if model.model.format != "gltf":
		return []

	var graph = BlueprintTemplate.instantiate()
	graph.name = "glTF/VRM Standard"

	var breathe = graph.spawn_action(&"breathe", model)
	var blink = graph.spawn_action(&"blink", model)

	breathe.position_offset = Vector2(-500, 0)
	blink.position_offset = Vector2(-500, 250)

	var column_width = 0
	var x = 0
	var y = 0
	for input_parameter in DEFAULT_BINDINGS:
		for output_parameter in DEFAULT_BINDINGS[input_parameter]:
			if StringName(output_parameter.name) not in model.parameters:
				continue

			var input = graph.spawn_action(&"tracking_parameter", model)
			var output = graph.spawn_action(&"model_parameter", model)
			var _x = x

			input.parameter = input_parameter
			input.clamp_range = Registry[input_parameter].range
			output.parameter = model.parameters.keys().find(output_parameter.name)
			output.clamp_range = output_parameter.value_range
			input.position_offset = Vector2(x, y)
			_x += input.size.x + spacing

			if output_parameter.get("smoothing", 0) > 0:
				var smoothing = graph.spawn_action(&"smoothing", model)

				smoothing.smoothing = output_parameter.get("smoothing", 0) / 100.0
				graph._on_connection_request(
					input.name, 0, smoothing.name, 0
				)
				smoothing.position_offset = Vector2(_x, y)
				_x += smoothing.size.x + spacing
				input = smoothing

			if input != null:
				graph._on_connection_request(
					input.name, 0, output.name, 0
				)

			output.position_offset = Vector2(_x, y)
			y += output.size.y + 96
			_x += output.size.x + 120

			column_width = max(column_width, _x + 200)

			if y > 2000:
				x += column_width - x
				y = 0
				column_width = 0
	return [
		graph
	]
