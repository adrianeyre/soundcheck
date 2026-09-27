if(SMTG_WIN)
    set(module_source ${VST3_SDK_DIR}/public.sdk/source/vst/hosting/module_win32.cpp)
else()
    set(module_source ${VST3_SDK_DIR}/public.sdk/source/vst/hosting/module_linux.cpp)
endif()

add_executable(soundcheck-vst3-host
    host.cpp
    shared.h
    ${VST3_SDK_DIR}/public.sdk/source/common/memorystream.cpp
    ${VST3_SDK_DIR}/public.sdk/source/vst/hosting/plugprovider.cpp
    ${module_source}
)
target_compile_features(soundcheck-vst3-host PRIVATE cxx_std_17)
target_link_libraries(soundcheck-vst3-host PRIVATE sdk_hosting)
if(SMTG_WIN)
    # A window program with no console of its own; avrt for MMCSS.
    target_compile_definitions(soundcheck-vst3-host PRIVATE UNICODE _UNICODE NOMINMAX)
    target_link_libraries(soundcheck-vst3-host PRIVATE avrt user32)
else()
    target_link_libraries(soundcheck-vst3-host PRIVATE pthread rt dl)
endif()
set_target_properties(soundcheck-vst3-host PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
    RUNTIME_OUTPUT_DIRECTORY_RELEASE ${CMAKE_BINARY_DIR}/bin
    RUNTIME_OUTPUT_DIRECTORY_DEBUG ${CMAKE_BINARY_DIR}/bin
)
