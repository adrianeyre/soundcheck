# A throwaway spike for #69: hosting VST3 Plugins in a separate process. Its own
# CMake project and Cargo workspace, so nothing here is built, linted or tested
# with the app.
#
# It builds, against Steinberg's VST3 SDK:
# - soundcheck-vst3-host, the helper process that loads one Plugin and runs it;
# - spike-faulty.vst3, an Effect written to crash or hang when told to;
# - the SDK's own example Plugins, which the tests load.
cmake_minimum_required(VERSION 3.25)

project(soundcheck-vst3-spike LANGUAGES C CXX)

# Point this at an SDK checkout to skip the download, or leave it empty.
set(VST3_SDK_DIR "" CACHE PATH "A checkout of steinbergmedia/vst3sdk")

if(VST3_SDK_DIR STREQUAL "")
    include(FetchContent)
    # The SDK's latest release when this was written (MIT since 3.8.0).
    FetchContent_Declare(vst3sdk
        GIT_REPOSITORY https://github.com/steinbergmedia/vst3sdk.git
        GIT_TAG v3.8.1_build_84
        GIT_SHALLOW TRUE
        GIT_SUBMODULES base cmake pluginterfaces public.sdk
        SOURCE_SUBDIR do-not-add
    )
    FetchContent_MakeAvailable(vst3sdk)
    set(VST3_SDK_DIR ${vst3sdk_SOURCE_DIR})
endif()

# No VSTGUI (it needs X11 libraries the sandbox lacks, and nothing here draws),
# no hosting examples, and the SDK's example Plugins on: they are what the
# tests load.
set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES ON CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)

add_subdirectory(${VST3_SDK_DIR} vst3sdk)
smtg_enable_vst3_sdk()

add_subdirectory(helper)
add_subdirectory(faulty)
