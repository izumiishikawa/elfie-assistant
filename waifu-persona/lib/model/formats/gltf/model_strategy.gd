# System for loading glTF/VRM 3D avatars and spawning them into the scene to be managed,
# analogous to l2d/model_strategy.gd but rendering through an always-on 3D SubViewport
# (see model_viewport.gd) since 3D content has no direct-2D-canvas render path.
extends "../model_strategy.gd"

const VrmExtension = preload("./vrm_extension.gd")
const ModelViewport = preload("./model_viewport.gd")

## humanoid bone name -> max +/- rotation in degrees exposed per axis (x=pitch,y=yaw,z=roll)
const BONE_PARAMS = {
	"head": Vector3(30, 45, 20),
	"neck": Vector3(15, 20, 10),
	"spine": Vector3(8, 10, 6),
	"leftEye": Vector3(15, 20, 0),
	"rightEye": Vector3(15, 20, 0),
}
const AXIS_KEYS = ["rotX", "rotY", "rotZ"]

## api/src/controllers/chats.controller.js's EMOTION_TO_EXPRESSION sends these l2d-style
## filenames to VtModel.toggle_expression() regardless of model format — map each to the
## closest VRM canonical expression so speech-driven expressions work on gltf models too.
const L2D_EXPRESSION_ALIASES = {
	"Angry.exp3.json": "angry",
	"Cry.exp3.json": "sad",
	"Amazed.exp3.json": "surprised",
	"Love.exp3.json": "happy",
	"Nervous.exp3.json": "relaxed",
}

var viewport_container: Control
var model_root: Node3D
var skeleton: Skeleton3D

var _bone_indices: Dictionary = {} # humanoid_name -> bone_idx
var _bone_rest: Dictionary = {} # humanoid_name -> Quaternion
var _blend_shape_targets: Dictionary = {} # canonical_name -> Array[{mesh, index, weight}]
var _meshes: Array = []
var _parameters: Dictionary = {}

func _ready() -> void:
	viewport_container = preload("./model_viewport.tscn").instantiate()
	add_child(viewport_container)

func is_initialized() -> bool:
	return model_root != null

func get_meshes() -> Array:
	return _meshes

func get_parameters() -> Dictionary:
	if is_initialized():
		return _parameters
	return {}

func get_size() -> Vector2:
	return Vector2(ModelViewport.VIEWPORT_SIZE)

func get_origin() -> Vector2:
	return Vector2.ZERO

func _walk(root: Node, cb: Callable) -> void:
	var stack: Array = [root]
	while not stack.is_empty():
		var n = stack.pop_back()
		cb.call(n)
		for c in n.get_children():
			stack.append(c)

func _resolve_skeleton_and_targets(vrm: VrmExtension) -> void:
	skeleton = null
	_meshes = []
	_bone_indices = {}
	_bone_rest = {}
	_blend_shape_targets = {}

	var meshes_by_name: Dictionary = {}
	_walk(model_root, func (n):
		if skeleton == null and n is Skeleton3D:
			skeleton = n
		if n is MeshInstance3D:
			_meshes.append(n)
			meshes_by_name[n.name] = n
	)

	if skeleton != null:
		for bone_name in BONE_PARAMS:
			var node_name: String = vrm.humanoid_bones.get(bone_name, "")
			if node_name.is_empty():
				continue
			var idx = skeleton.find_bone(node_name)
			if idx < 0:
				continue
			_bone_indices[bone_name] = idx
			_bone_rest[bone_name] = skeleton.get_bone_pose_rotation(idx)

	for canonical in vrm.expressions:
		var targets: Array = []
		for bind in vrm.expressions[canonical]:
			var mesh: MeshInstance3D = meshes_by_name.get(bind.node_name)
			if mesh == null or bind.morph_index < 0 or bind.morph_index >= mesh.get_blend_shape_count():
				continue
			targets.append({"mesh": mesh, "index": bind.morph_index, "weight": bind.weight})
		if not targets.is_empty():
			_blend_shape_targets[canonical] = targets

func _build_parameters(vrm: VrmExtension) -> void:
	_parameters = {}

	for bone_name in _bone_indices:
		var ranges: Vector3 = BONE_PARAMS[bone_name]
		for i in range(3):
			var limit: float = ranges[i]
			if limit <= 0.0:
				continue
			_parameters["Bone:%s:%s" % [bone_name, AXIS_KEYS[i]]] = {
				"default": 0.0, "min": -limit, "max": limit
			}

	for canonical in _blend_shape_targets:
		_parameters[canonical] = {"default": 0.0, "min": 0.0, "max": 1.0}

func _build_expression_library() -> Dictionary:
	var library := {}
	for filename in L2D_EXPRESSION_ALIASES:
		var canonical: String = L2D_EXPRESSION_ALIASES[filename]
		if not _blend_shape_targets.has(canonical):
			continue
		library[filename] = {
			"Parameters": [
				{"Id": canonical, "Blend": "Overwrite", "Value": 1.0}
			]
		}
	return library

func load_model() -> bool:
	var meta: ModelMeta = get_parent().model

	var doc = GLTFDocument.new()
	var state = GLTFState.new()
	var err = doc.append_from_file(meta.model, state)
	if err != OK:
		push_error("could not load gltf/vrm model %s (error %d)" % [meta.model, err])
		return false

	var vrm = VrmExtension.new()
	vrm.parse(state.get_json())

	var scene_root = doc.generate_scene(state)
	if scene_root == null:
		push_error("gltf import produced no scene for %s" % meta.model)
		return false

	if model_root != null:
		model_root.queue_free()
	model_root = scene_root

	await get_tree().process_frame # let ModelViewport's @onready vars resolve

	# VRM 0.x models are authored facing -Z (the opposite of VRM 1.0's +Z convention) —
	# Godot's glTF importer doesn't know about that VRM-specific quirk, so without this
	# the model renders with its back to the camera. Horizontal-scroll over the avatar
	# (see model_viewport.gd's _unhandled_input) lets the user turn it further from here.
	viewport_container.set_model(model_root, 180.0 if vrm.version == "0.x" else 0.0)
	_resolve_skeleton_and_targets(vrm)
	_build_parameters(vrm)
	get_parent().expression_controller.expression_library = _build_expression_library()

	position = -get_size() / 2 # align to top-left, matching l2d/model_strategy.gd

	return true

func apply_parameters(values: Dictionary):
	if not is_initialized():
		return

	var bone_euler: Dictionary = {}
	for key in values:
		# vt_model.gd's _load_model() seeds `parameters` with format_strategy.get_parameters()
		# itself once (the {default,min,max} metadata dict, not flat floats) before the mixer
		# takes over next frame with real values — skip anything that isn't numeric yet.
		if not (values[key] is float or values[key] is int):
			continue
		if String(key).begins_with("Bone:"):
			var parts = String(key).split(":")
			if parts.size() != 3:
				continue
			var bone_name: String = parts[1]
			if not bone_euler.has(bone_name):
				bone_euler[bone_name] = Vector3.ZERO
			var rad = deg_to_rad(float(values[key]))
			match parts[2]:
				"rotX": bone_euler[bone_name].x = rad
				"rotY": bone_euler[bone_name].y = rad
				"rotZ": bone_euler[bone_name].z = rad
		elif _blend_shape_targets.has(key):
			var amount = clampf(float(values[key]), 0.0, 1.0)
			for t in _blend_shape_targets[key]:
				t.mesh.set_blend_shape_value(t.index, amount * t.weight)

	for bone_name in bone_euler:
		if not _bone_indices.has(bone_name):
			continue
		var idx: int = _bone_indices[bone_name]
		var rest: Quaternion = _bone_rest.get(bone_name, Quaternion.IDENTITY)
		skeleton.set_bone_pose_rotation(idx, rest * Quaternion.from_euler(bone_euler[bone_name]))

func tracking_updated(tracking_data: Dictionary):
	if not get_parent().movement_enabled:
		return

	var moved = Vector3(
		Registry.signed_ilerp_input(
			tracking_data.get("FacePositionX", 0),
			"FacePositionX",
		),
		Registry.signed_ilerp_input(
			tracking_data.get("FacePositionY", 0),
			"FacePositionY",
		),
		Registry.signed_ilerp_input(
			tracking_data.get("FacePositionZ", 0),
			"FacePositionZ",
		)
	)
	var movement = moved * get_parent().movement_scale
	scale = Vector2.ONE + (Vector2.ONE * movement.z)

func on_filter_update(filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS, smoothing = false):
	if viewport_container:
		viewport_container.texture_filter = filter
