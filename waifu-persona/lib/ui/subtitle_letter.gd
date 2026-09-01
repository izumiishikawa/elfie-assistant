extends RigidBody2D

@onready var label: Label = $Label

var _tween: Tween
var _flip_tween: Tween

func setup(character: String, font: Font, font_size: int, text_color: Color, outline_color: Color, outline_size: int) -> void:
	label.text = character
	label.add_theme_font_override("font", font)
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", text_color)
	label.add_theme_color_override("font_outline_color", outline_color)
	label.add_theme_constant_override("outline_size", outline_size)
	label.add_theme_color_override("font_shadow_color", Color(0.0, 0.0, 0.0, 0.35))
	label.add_theme_constant_override("shadow_offset_x", 3)
	label.add_theme_constant_override("shadow_offset_y", 3)
	# centraliza o glifo em torno da origem do corpo fisico (aproximado, nao por-glifo)
	label.position = Vector2(-font_size * 0.32, -font_size * 0.62)

## Aparece no lugar (sem se mover) com um "pop": comeca grande e encolhe ate o
## tamanho normal quicando levemente, com um pequeno atraso pra dar cascata entre letras.
func fly_in(target_pos: Vector2, delay: float) -> void:
	visible = false
	position = target_pos
	rotation = randf_range(-0.15, 0.15)
	scale = Vector2(1.9, 1.9)
	modulate.a = 0.0

	if _tween:
		_tween.kill()
	if _flip_tween:
		_flip_tween.kill()
	scale.y = 1.0
	_tween = create_tween()
	_tween.tween_interval(delay)
	_tween.tween_callback(func(): visible = true)
	_tween.set_parallel(true)
	_tween.tween_property(self, "scale", Vector2.ONE, 0.4) \
		.set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	_tween.tween_property(self, "rotation", 0.0, 0.3) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)
	_tween.tween_property(self, "modulate:a", 1.0, 0.15)

## Solta a fisica pra letra cair, com um impulso tipo "explosao" — forca, direcao e
## torque diferentes em cada letra, entao umas voam mais longe/dao um pulinho antes
## de cair e outras mal se mexem, como se uma forca desigual tivesse sido aplicada.
## Junto, simula um tombo "3D" (a letra deita/fica em pe, tipo uma tabua caindo).
func fall(delay: float) -> void:
	if _tween:
		_tween.kill()
	if delay > 0.0:
		await get_tree().create_timer(delay).timeout
	if not is_instance_valid(self):
		return
	freeze = false
	gravity_scale = 1.0
	var strength: float = randf_range(0.4, 1.7)
	var impulse: Vector2 = Vector2(randf_range(-160.0, 160.0), randf_range(-260.0, -30.0)) * strength
	apply_central_impulse(impulse)
	apply_torque_impulse(randf_range(-450.0, 450.0) * strength)
	_tumble_3d(strength)

## Encolhe/estica o eixo vertical enquanto cai, simulando a letra tombando pra
## frente/tras como um objeto real (tipo uma tabua de madeira) — no final "assenta"
## deitada, em pe ou inclinada, sorteado por letra, dando a sensacao de queda 3D.
func _tumble_3d(strength: float) -> void:
	if _flip_tween:
		_flip_tween.kill()

	var flips: int = randi_range(1, 3)
	var flip_time: float = randf_range(0.09, 0.16) / maxf(strength, 0.5)
	var lying_down: bool = randf() < 0.55
	var rest_scale_y: float = randf_range(0.06, 0.22) if lying_down else randf_range(0.7, 1.0)

	_flip_tween = create_tween()
	for i in range(flips):
		_flip_tween.tween_property(self, "scale:y", 0.04, flip_time) \
			.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN)
		_flip_tween.tween_property(self, "scale:y", 1.0, flip_time) \
			.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)
	_flip_tween.tween_property(self, "scale:y", rest_scale_y, flip_time * 1.5) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)

## Cascata de sumico: encolhe e desaparece antes de ser removida de vez.
func vanish(fade_time: float) -> void:
	if _tween:
		_tween.kill()
	if _flip_tween:
		_flip_tween.kill()
	_tween = create_tween()
	_tween.set_parallel(true)
	_tween.tween_property(self, "modulate:a", 0.0, fade_time)
	_tween.tween_property(self, "scale", Vector2.ZERO, fade_time) \
		.set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_IN)
