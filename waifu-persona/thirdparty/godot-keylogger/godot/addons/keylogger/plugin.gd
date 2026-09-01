@tool
extends EditorPlugin

func _enter_tree() -> void:
	add_autoload_singleton("GlobalInput", "res://addons/keylogger/keylogger.tscn")
	pass

func _exit_tree() -> void:
	# Clean-up of the plugin goes here.
	pass
