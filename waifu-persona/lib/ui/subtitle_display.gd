extends Node2D

const LetterScene := preload("res://lib/ui/subtitle_letter.tscn")
const SubtitleLetterScript := preload("res://lib/ui/subtitle_letter.gd")

const FONT_SIZE := 42
const TEXT_COLOR := Color(0.56, 0.27, 0.85)  # violeta
const OUTLINE_COLOR := Color(1.0, 1.0, 1.0)  # branco
const OUTLINE_SIZE := 9

# janela do waifu-persona é 540x820 (project.godot) — texto perto do fundo da
# janela, chão da fisica de queda fica bem na borda inferior (ver Floor na .tscn)
const TEXT_AREA_LEFT := 40.0
const TEXT_AREA_RIGHT := 500.0
const TEXT_BASELINE_Y := 660.0  # onde a ULTIMA linha do texto fica enquanto "em pe"
const LINE_HEIGHT := 58.0

const WORDS_PER_CHUNK := 4        # quantas palavras aparecem de cada vez
const MIN_CHUNK_HOLD := 0.45      # tempo minimo de leitura por pedaco, mesmo se a fala for rapida
const APPEAR_STAGGER := 0.035    # atraso entre cada letra comecando a voar pra posicao
const FALL_SETTLE_TIME := 0.55   # quanto tempo as letras ficam caidas no chao antes de sumir
const VANISH_FADE_TIME := 0.35

var _font: Font
var _active_batches: Array = []  # Array de Array de letras — as que ainda estao de pe
var _generation: int = 0         # invalida pedacos agendados de uma frase anterior/interrompida

func _ready() -> void:
	add_to_group("system:subtitles")
	_font = SystemFont.new()
	_font.font_weight = 800
	_font.subpixel_positioning = 0

func _string_w(s: String) -> float:
	var size: Vector2 = _font.get_string_size(s, HORIZONTAL_ALIGNMENT_LEFT, -1, FONT_SIZE)
	return size.x

## Quebra o texto em linhas que cabem em TEXT_AREA_LEFT..TEXT_AREA_RIGHT e devolve,
## por caractere visivel (sem espacos), o par {"char": String, "pos": Vector2}.
func _layout(text: String) -> Array[Dictionary]:
	var max_w: float = TEXT_AREA_RIGHT - TEXT_AREA_LEFT
	var space_w: float = _string_w(" ")

	var words: PackedStringArray = text.split(" ", false)
	var lines: Array = []
	var current: Array = []
	var current_w: float = 0.0
	for word in words:
		var w: float = _string_w(word)
		var extra: float = space_w if current.size() > 0 else 0.0
		if current.size() > 0 and current_w + extra + w > max_w:
			lines.append(current)
			current = []
			current_w = 0.0
			extra = 0.0
		current.append(word)
		current_w += extra + w
	if current.size() > 0:
		lines.append(current)

	var num_lines: int = lines.size()
	var start_y: float = TEXT_BASELINE_Y - float(num_lines - 1) * LINE_HEIGHT

	var result: Array[Dictionary] = []
	for li in range(num_lines):
		var line_words: Array = lines[li]
		var line_text: String = " ".join(line_words)
		var line_w: float = _string_w(line_text)
		var x: float = TEXT_AREA_LEFT + maxf(0.0, (max_w - line_w) * 0.5)
		var y: float = start_y + float(li) * LINE_HEIGHT
		for ci in range(line_text.length()):
			var ch: String = line_text[ci]
			var ch_w: float = _string_w(ch)
			if ch != " ":
				result.append({"char": ch, "pos": Vector2(x, y)})
			x += ch_w
	return result

## Quebra o texto em pedacos de poucas palavras (WORDS_PER_CHUNK), pra nao jogar a
## frase inteira de uma vez — cada pedaco recebe uma fatia proporcional da duracao.
func _split_into_chunks(text: String) -> Array[String]:
	var words: PackedStringArray = text.split(" ", false)
	var chunks: Array[String] = []
	var i: int = 0
	while i < words.size():
		var group: PackedStringArray = words.slice(i, mini(i + WORDS_PER_CHUNK, words.size()))
		chunks.append(" ".join(Array(group)))
		i += WORDS_PER_CHUNK
	return chunks

## Mostra o texto em pedacos de poucas palavras, cronometrados pra acompanhar o
## ritmo real da fala: cada pedaco recebe uma fatia de "duration" proporcional ao
## seu tamanho, e aparece no seu horario certo — sem esperar a queda/sumico do
## pedaco anterior (elas nao colidem entre si, entao podem se sobrepor no tempo).
func show_text(text: String, duration: float) -> void:
	if text.is_empty():
		return
	var chunks: Array[String] = _split_into_chunks(text)
	if chunks.is_empty():
		return

	_generation += 1
	var my_gen: int = _generation

	var total_len: int = 0
	for chunk in chunks:
		total_len += chunk.length()
	total_len = maxi(total_len, 1)

	var offset: float = 0.0
	for chunk in chunks:
		var chunk_duration: float = maxf(duration * float(chunk.length()) / float(total_len), MIN_CHUNK_HOLD)
		_schedule(chunk, chunk_duration, offset, my_gen)
		offset += chunk_duration

func _schedule(text: String, duration: float, delay: float, gen: int) -> void:
	if delay <= 0.0:
		_show_now(text, duration, gen)
		return
	var timer: SceneTreeTimer = get_tree().create_timer(delay)
	timer.timeout.connect(func(): _show_now(text, duration, gen))

func _show_now(text: String, duration: float, gen: int) -> void:
	if gen != _generation:
		return  # frase foi interrompida/substituida antes desse pedaco chegar a vez
	var layout: Array[Dictionary] = _layout(text)
	var batch: Array = []
	for i in range(layout.size()):
		var item: Dictionary = layout[i]
		var letter: SubtitleLetterScript = LetterScene.instantiate()
		add_child(letter)
		letter.setup(item["char"], _font, FONT_SIZE, TEXT_COLOR, OUTLINE_COLOR, OUTLINE_SIZE)
		letter.fly_in(item["pos"], i * APPEAR_STAGGER)
		batch.append(letter)

	_active_batches.append(batch)

	var fall_start: float = maxf(duration - 0.1, 0.15)
	var fall_timer: SceneTreeTimer = get_tree().create_timer(fall_start)
	fall_timer.timeout.connect(func(): _drop_batch(batch))

func _drop_batch(batch: Array) -> void:
	if not _active_batches.has(batch):
		return  # ja foi derrubado (ex: hide_text chamado antes do timer)
	_active_batches.erase(batch)  # marca como "caindo" — evita derrubar duas vezes

	for letter in batch:
		if is_instance_valid(letter):
			letter.fall(0.0)  # todas caem juntas, ao mesmo tempo — sem cascata na saida

	var settle_timer: SceneTreeTimer = get_tree().create_timer(FALL_SETTLE_TIME)
	settle_timer.timeout.connect(func(): _vanish_batch(batch))

func _vanish_batch(batch: Array) -> void:
	for letter in batch:
		if is_instance_valid(letter):
			letter.vanish(VANISH_FADE_TIME)
	var cleanup_timer: SceneTreeTimer = get_tree().create_timer(VANISH_FADE_TIME + 0.1)
	cleanup_timer.timeout.connect(func(): _cleanup_batch(batch))

func _cleanup_batch(batch: Array) -> void:
	for letter in batch:
		if is_instance_valid(letter):
			letter.queue_free()
	_active_batches.erase(batch)

## Chamado quando a fila de fala inteira acaba — cancela pedacos ainda agendados
## (nao mostrados) e derruba qualquer letra ainda de pe.
func hide_text() -> void:
	_generation += 1
	for batch in _active_batches.duplicate():
		_drop_batch(batch)
