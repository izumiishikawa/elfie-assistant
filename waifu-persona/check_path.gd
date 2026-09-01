extends SceneTree

func _init():
    var p = ProjectSettings.globalize_path("user://Live2DModels")
    print("USER_PATH: " + p)
    var dirs = DirAccess.get_directories_at("user://Live2DModels")
    print("DIRS: " + str(dirs))
    quit()
