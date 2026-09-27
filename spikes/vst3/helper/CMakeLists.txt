if(SMTG_WIN)
    set(module_source ${VST3_SDK_DIR}/public.sdk/source/vst/hosting/module_win32.cpp)
elseif(SMTG_MAC)
    set(module_source ${VST3_SDK_DIR}/public.sdk/source/vst/hosting/module_mac.mm)
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
if(SMTG_LINUX)
    target_link_libraries(soundcheck-vst3-host PRIVATE pthread rt dl)
endif()
set_target_properties(soundcheck-vst3-host PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
)
