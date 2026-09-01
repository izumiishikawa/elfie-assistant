#pragma once

#include "godot_cpp/classes/ref_counted.hpp"
#include "godot_cpp/classes/node.hpp"
#include "godot_cpp/classes/viewport.hpp"
#include "godot_cpp/classes/wrapped.hpp"
#include "godot_cpp/variant/variant.hpp"
#include "godot_cpp/classes/viewport_texture.hpp"
#include "godot_cpp/classes/image.hpp"

using namespace godot;

class VirtualCamera : public Node {
	GDCLASS(VirtualCamera, Node)

private:
	int32_t output; // device buffer
	Viewport* source;
	String camera;

	// cached dimensions
	int32_t frame_width = 1;
	int32_t frame_height = 1;
	int32_t frame_size = 4;

	int32_t _connect_to_device();

protected:
	static void _bind_methods() {
		ClassDB::bind_method(D_METHOD("set_viewport", "viewport"), &VirtualCamera::set_viewport);
        ClassDB::bind_method(D_METHOD("get_viewport"), &VirtualCamera::get_viewport);
		ADD_PROPERTY(PropertyInfo(Variant::OBJECT, "viewport", PropertyHint::PROPERTY_HINT_NODE_TYPE, "SubViewport"), "set_viewport", "get_viewport");

		ClassDB::bind_method(D_METHOD("set_loopback_device", "device_id"), &VirtualCamera::set_camera);
        ClassDB::bind_method(D_METHOD("get_loopback_device"), &VirtualCamera::get_camera);
        ADD_PROPERTY(PropertyInfo(Variant::STRING, "loopback_device"), "set_loopback_device", "get_loopback_device");
	}

public:
    VirtualCamera();
    ~VirtualCamera();

	void set_viewport(Viewport* viewport) {
		this->source = viewport;

		this->frame_width = this->source->get_texture()->get_width();
		this->frame_height = this->source->get_texture()->get_height();
		this->frame_size = 4 * this->frame_height * this->frame_width;
	
		this->output = this->_connect_to_device();
	}

	Viewport* get_viewport() const {
		return this->source;
	}

	void set_camera(const String device_id) {
		this->camera = device_id;

		this->output = this->_connect_to_device();
	}

	String get_camera() const {
		return this->camera;
	}

	void _process(double delta) override;
};
