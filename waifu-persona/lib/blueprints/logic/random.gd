extends "../vt_action.gd"

enum Phase { HOLD, TRANSITION }

var rng := RandomNumberGenerator.new()
var _phase := Phase.HOLD
var _phase_start_ms: float = 0.0
var _phase_duration_ms: float = 0.0
var _current: float = 0.0
var _transition_start: float = 0.0
var _target: float = 0.0

var min_value: float:
	get(): return %Min.value
	set(v): %Min.value = v

var max_value: float:
	get(): return %Max.value
	set(v): %Max.value = v

var hold_ms: float:
	get(): return %Hold.value
	set(v): %Hold.value = v

var transition_ms: float:
	get(): return %Transition.value
	set(v): %Transition.value = v

var use_seed: bool:
	get(): return %UseSeed.button_pressed
	set(v):
		%UseSeed.button_pressed = v
		if is_node_ready():
			%Seed.editable = v

var seed_value: int:
	get(): return int(%Seed.value)
	set(v): %Seed.value = v

func get_type() -> StringName:
	return &"random"

func serialize() -> Dictionary:
	return {
		"min": min_value,
		"max": max_value,
		"hold": hold_ms,
		"transition": transition_ms,
		"seed": seed_value if use_seed else null,
	}

func deserialize(data: Dictionary) -> void:
	min_value = data.get("min", -1.0)
	max_value = data.get("max", 1.0)
	hold_ms = data.get("hold", 1000.0)
	transition_ms = data.get("transition", 500.0)
	var s = data.get("seed", null)
	use_seed = s != null
	if s != null:
		seed_value = int(s)

func get_value(_slot: int) -> float:
	return _current

func _ready() -> void:
	%Seed.editable = use_seed
	_init_rng()
	_current = rng.randf_range(min_value, max_value)
	_transition_start = _current
	_target = _current
	_start_hold()

func _init_rng() -> void:
	if use_seed:
		rng.seed = seed_value
	else:
		rng.randomize()

func _jitter(base: float) -> float:
	return base * rng.randf_range(0.8, 1.2)

func _start_hold() -> void:
	_phase = Phase.HOLD
	_phase_start_ms = Time.get_ticks_msec()
	_phase_duration_ms = _jitter(hold_ms)

func _start_transition() -> void:
	_transition_start = _current
	_target = rng.randf_range(min_value, max_value)
	_phase = Phase.TRANSITION
	_phase_start_ms = Time.get_ticks_msec()
	_phase_duration_ms = _jitter(transition_ms)

func _process(_delta: float) -> void:
	var now := Time.get_ticks_msec()
	var elapsed := now - _phase_start_ms

	match _phase:
		Phase.HOLD:
			if elapsed >= _phase_duration_ms:
				_start_transition()
		Phase.TRANSITION:
			if elapsed >= _phase_duration_ms:
				_current = _target
				_start_hold()
			else:
				var t := elapsed / _phase_duration_ms
				t = smoothstep(0.0, 1.0, t)
				_current = lerp(_transition_start, _target, t)

	%Output.set_value_no_signal(_current)
	slot_updated.emit(0)

func _on_use_seed_toggled(toggled_on: bool) -> void:
	%Seed.editable = toggled_on
	_init_rng()
