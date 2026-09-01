## Parses the VRM 0.x (`extensions.VRM`) and VRM 1.0 (`extensions.VRMC_vrm`) blocks out of a
## raw glTF JSON document (GLTFState.get_json()) into a format-agnostic shape the gltf
## model strategy can consume without caring which VRM spec version produced the file.
extends RefCounted

## VRM 0.x blendShapePresetName -> VRM 1.0-style canonical expression name
const PRESET_0X_TO_CANONICAL = {
	"a": "aa", "i": "ih", "u": "ou", "e": "ee", "o": "oh",
	"blink": "blink", "blink_l": "blinkLeft", "blink_r": "blinkRight",
	"joy": "happy", "angry": "angry", "sorrow": "sad", "fun": "relaxed",
	"lookup": "lookUp", "lookdown": "lookDown", "lookleft": "lookLeft", "lookright": "lookRight",
	"neutral": "neutral", "surprised": "surprised",
}

## {humanoid_bone_name: gltf_node_name}
var humanoid_bones: Dictionary = {}
## {canonical_expression_name: Array[{node_name, morph_index, weight}]}
var expressions: Dictionary = {}
## "bone" | "expression" | "none"
var look_at_type: String = "none"
var meta_name: String = ""
var version: String = "" # "0.x" | "1.0" | ""

func parse(json: Dictionary) -> bool:
	var nodes: Array = json.get("nodes", [])
	var meshes: Array = json.get("meshes", [])
	var exts: Dictionary = json.get("extensions", {})

	if exts.has("VRMC_vrm"):
		_parse_1_0(exts["VRMC_vrm"], nodes)
		version = "1.0"
		return true
	elif exts.has("VRM"):
		_parse_0_x(exts["VRM"], nodes, meshes)
		version = "0.x"
		return true
	return false

func _node_name(nodes: Array, idx: int) -> String:
	if idx < 0 or idx >= nodes.size():
		return ""
	return nodes[idx].get("name", "")

func _parse_1_0(vrmc: Dictionary, nodes: Array) -> void:
	meta_name = vrmc.get("meta", {}).get("name", "")
	look_at_type = vrmc.get("lookAt", {}).get("type", "none")

	var humanoid: Dictionary = vrmc.get("humanoid", {}).get("humanBones", {})
	for bone_name in humanoid:
		var node_idx: int = int(humanoid[bone_name].get("node", -1))
		var name := _node_name(nodes, node_idx)
		if not name.is_empty():
			humanoid_bones[bone_name] = name

	var expr: Dictionary = vrmc.get("expressions", {})
	for group_name in ["preset", "custom"]:
		var groups: Dictionary = expr.get(group_name, {})
		for name in groups:
			if expressions.has(name):
				continue
			var binds: Array = groups[name].get("morphTargetBinds", [])
			var out: Array = []
			for b in binds:
				var node_idx: int = int(b.get("node", -1))
				var node_name := _node_name(nodes, node_idx)
				if node_name.is_empty():
					continue
				out.append({
					"node_name": node_name,
					"morph_index": int(b.get("index", -1)),
					"weight": float(b.get("weight", 1.0)),
				})
			if not out.is_empty():
				expressions[name] = out

func _parse_0_x(vrm: Dictionary, nodes: Array, meshes: Array) -> void:
	meta_name = vrm.get("meta", {}).get("title", "")
	look_at_type = "bone" if vrm.get("firstPerson", {}).get("lookAtTypeName", "Bone") == "Bone" else "expression"

	var humanoid: Array = vrm.get("humanoid", {}).get("humanBones", [])
	for entry in humanoid:
		var bone_name: String = entry.get("bone", "")
		var node_idx: int = int(entry.get("node", -1))
		var name := _node_name(nodes, node_idx)
		if not bone_name.is_empty() and not name.is_empty():
			humanoid_bones[bone_name] = name

	# 0.x binds reference a mesh index, not a node index — resolve to the first
	# node that references that mesh, since that's what carries the morph targets.
	var mesh_to_node_name: Dictionary = {}
	for i in range(nodes.size()):
		var mesh_idx = nodes[i].get("mesh")
		if mesh_idx != null and not mesh_to_node_name.has(int(mesh_idx)):
			mesh_to_node_name[int(mesh_idx)] = _node_name(nodes, i)

	var groups: Array = vrm.get("blendShapeMaster", {}).get("blendShapeGroups", [])
	for g in groups:
		var preset_name: String = String(g.get("presetName", "unknown")).to_lower()
		var canonical: String = PRESET_0X_TO_CANONICAL.get(preset_name, g.get("name", preset_name))
		if canonical.is_empty() or expressions.has(canonical):
			continue
		var out: Array = []
		for b in g.get("binds", []):
			var mesh_idx: int = int(b.get("mesh", -1))
			var node_name: String = mesh_to_node_name.get(mesh_idx, "")
			if node_name.is_empty():
				continue
			out.append({
				"node_name": node_name,
				"morph_index": int(b.get("index", -1)),
				# 0.x bind weight is a 0-100 percentage, not a 0-1 factor
				"weight": float(b.get("weight", 100.0)) / 100.0,
			})
		if not out.is_empty():
			expressions[canonical] = out
