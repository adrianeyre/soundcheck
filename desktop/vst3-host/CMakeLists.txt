# soundcheck-vst3-host, the helper process that runs one VST3 Plugin for the
# Desktop App (ADR 0008), and the test Plugin its tests load. Its own CMake
# project: `pnpm lint`, `test` and `build` don't build it; `pnpm vst3:build`
# and CI's `vst3` job do.
#
# It builds, against Steinberg's VST3 SDK:
# - soundcheck-vst3-host, the helper, at build/bin/;
# - soundcheck-test-faulty.vst3, an Effect that crashes, hangs or runs slow
#   when told to, and the SDK's own example Plugins (ADelay, AGain, the mda
#   set), at build/VST3/<config>/. Nothing built here is ever committed.
cmake_minimum_required(VERSION 3.25)

project(soundcheck-vst3-host LANGUAGES C CXX)

if(APPLE)
    # ADR 0008's macOS row (its semaphores and its window) comes later.
    message(FATAL_ERROR "The VST3 helper isn't built for macOS yet (ADR 0008, slice 6)")
endif()

# Point this at an SDK checkout to skip the download, or leave it empty.
set(VST3_SDK_DIR "" CACHE PATH "A checkout of steinbergmedia/vst3sdk")
# Off for a release build, which needs only the helper.
option(SOUNDCHECK_VST3_TEST_PLUGINS "Build the test Plugin and the SDK's examples" ON)

if(VST3_SDK_DIR STREQUAL "")
    include(FetchContent)
    # The SDK's latest release (MIT since 3.8.0).
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

# No VSTGUI (it needs X11 libraries CI's Linux runner and the sandbox lack, and
# the helper draws nothing itself), no hosting examples, and the SDK's example
# Plugins only when the tests want them.
set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES ${SOUNDCHECK_VST3_TEST_PLUGINS} CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)

add_subdirectory(${VST3_SDK_DIR} vst3sdk)
smtg_enable_vst3_sdk()

add_subdirectory(src)
if(SOUNDCHECK_VST3_TEST_PLUGINS)
    add_subdirectory(test-plugin)
endif()
