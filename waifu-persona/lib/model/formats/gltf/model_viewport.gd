## Composites a 3D avatar (Node3D + Camera3D) into the 2D canvas, mirroring how
## l2d/pixel_subviewport.gd composites the Live2D SubViewport — 3D content has no
## direct-canvas render path, so unlike the l2d version this is always active.
extends SubViewportContainer

const VIEWPORT_SIZE = Vector2i(600, 900)
## renders internally at this multiple of VIEWPORT_SIZE then scales back down via
## `scale` below (same trick pixel_subviewport.gd uses) — supersampling for crisper
## edges, since a bare 600x900 render is visibly blocky/aliased for a face closeup.
const SUPERSAMPLE = 2
## fraction up the model's bounding box the camera looks at (bust framing)
const FRAME_HEIGHT_FRACTION = 0.78
const CAMERA_FOV = 25.0
## extra breathing room on the computed frame so geometry nearer to camera than the
## AABB's average depth (e.g. an arm bowed slightly forward) doesn't clip at the edges
const FRAME_MARGIN = 1.15

## degrees per horizontal-scroll tick when the user manually turns the model (see _unhandled_input)
const YAW_STEP_DEGREES = 5.0

@onready var viewport: SubViewport = $SubViewport
@onready var camera: Camera3D = $SubViewport/Camera3D
@onready var light: DirectionalLight3D = $SubViewport/DirectionalLight3D
@onready var root_anchor: Node3D = $SubViewport/RootAnchor

var _model_root: Node3D
var _yaw_degrees: float = 0.0

func _ready() -> void:
	size = Vector2(VIEWPORT_SIZE) # container's own Control size — its on-screen footprint
	scale = Vector2.ONE / SUPERSAMPLE # stretch=false draws the viewport texture unscaled, so shrink it back down to `size`
	viewport.size = Vector2i(VIEWPORT_SIZE) * SUPERSAMPLE
	viewport.msaa_3d = Viewport.MSAA_2X
	camera.fov = CAMERA_FOV

## `default_yaw_degrees` corrects for the model's authored forward axis (e.g. VRM 0.x
## models face -Z, the opposite of what this camera setup expects) — see model_strategy.gd.
func set_model(model_root: Node3D, default_yaw_degrees: float = 0.0) -> void:
	for c in root_anchor.get_children():
		c.queue_free()
	root_anchor.add_child(model_root)
	_model_root = model_root
	_yaw_degrees = default_yaw_degrees
	root_anchor.rotation_degrees.y = _yaw_degrees
	_frame_camera(model_root)

## Horizontal scroll (trackpad swipe, or a tilt-wheel mouse) turns the model in place.
## Deliberately not vertical-wheel/Ctrl+wheel — VtModel (see ui/draggable.gd) already
## uses those over this same screen area to scale/roll the flat 2D picture, and this
## needs to stay a separate gesture so the two don't fight over the same input.
func _unhandled_input(event: InputEvent) -> void:
	if _model_root == null or not (event is InputEventMouseButton and event.pressed):
		return
	if event.button_index != MOUSE_BUTTON_WHEEL_LEFT and event.button_index != MOUSE_BUTTON_WHEEL_RIGHT:
		return
	if not get_global_rect().has_point(get_global_mouse_position()):
		return

	var step = YAW_STEP_DEGREES if event.button_index == MOUSE_BUTTON_WHEEL_RIGHT else -YAW_STEP_DEGREES
	_yaw_degrees = wrapf(_yaw_degrees + step, -180.0, 180.0)
	root_anchor.rotation_degrees.y = _yaw_degrees
	_frame_camera(_model_root) # re-fit since the visible silhouette width changes as it turns
	get_viewport().set_input_as_handled()

func _frame_camera(model_root: Node3D) -> void:
	var aabb := AABB()
	var first := true
	var stack: Array = [model_root]
	while not stack.is_empty():
		var n = stack.pop_back()
		if n is VisualInstance3D:
			var world_aabb: AABB = n.global_transform * n.get_aabb()
			aabb = world_aabb if first else aabb.merge(world_aabb)
			first = false
		for c in n.get_children():
			stack.append(c)

	if first:
		return

	var target := Vector3(
		aabb.position.x + aabb.size.x / 2.0,
		aabb.position.y + aabb.size.y * FRAME_HEIGHT_FRACTION,
		aabb.position.z + aabb.size.z / 2.0
	)
	var visible_height = aabb.size.y * (1.0 - FRAME_HEIGHT_FRACTION + 0.22) * FRAME_MARGIN
	var distance = (visible_height / 2.0) / tan(deg_to_rad(CAMERA_FOV / 2.0))

	# also make sure the full width fits (bind pose is often a T-pose, arms spanning
	# the whole body) - the portrait viewport's horizontal FOV is narrower than the
	# vertical one, so a height-only distance can crop everything but a limb.
	var aspect = float(VIEWPORT_SIZE.x) / float(VIEWPORT_SIZE.y)
	var horizontal_fov = 2.0 * atan(tan(deg_to_rad(CAMERA_FOV) / 2.0) * aspect)
	var distance_for_width = (aabb.size.x * FRAME_MARGIN / 2.0) / tan(horizontal_fov / 2.0)
	distance = max(distance, distance_for_width)

	distance = max(distance, aabb.size.z + 0.3)

	camera.position = target + Vector3(0, 0, distance)
	camera.look_at(target, Vector3.UP)
