project(spike-faulty VERSION 1.0.0)

smtg_add_vst3plugin(spike-faulty
    faulty.cpp
    ${VST3_SDK_DIR}/public.sdk/source/vst/vstsinglecomponenteffect.cpp
)
target_link_libraries(spike-faulty PRIVATE sdk)
