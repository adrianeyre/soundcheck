// The block of shared memory the Desktop App and one helper process pass audio
// through (ADR 0008). `desktop/src/vst3/shared.rs` is the same layout in Rust;
// `SC_SHARED_VERSION` and the size check at startup keep the two in step.
//
// One block goes like this: the app writes the input audio, the setting
// changes and the notes, bumps `seq` and posts *go*. The helper processes the
// block straight into `out`, copies `seq` to `done_seq` and posts *done*. The
// app waits for *done* only until the block's deadline, so a Plugin that is
// slow, hung or dead can never hold up the song.
//
// *go* and *done* are process-shared POSIX semaphores inside the memory on
// Linux, and two named auto-reset events on Windows, where their slots here
// are unused. The layout is the same on both.
#pragma once

#include <stdint.h>

#define SC_SHARED_MAGIC 0x33545356u /* "VST3" */
#define SC_SHARED_VERSION 2u
#define SC_MAX_FRAMES 1024 /* the Desktop App's MAX_BLOCK */
#define SC_MAX_PARAM_CHANGES 64
#define SC_MAX_EVENTS 128

#define SC_EVENT_NOTE_ON 1u
#define SC_EVENT_NOTE_OFF 2u

/* The helper's answer for a block, in `status`. */
#define SC_STATUS_OK 0u
#define SC_STATUS_PLUGIN_ERROR 1u
#define SC_STATUS_CRASHED 2u /* the helper is dying: see its crash handler */

typedef struct {
    uint32_t id;     /* the Plugin's ParamID */
    uint32_t offset; /* the frame in the block where it changes */
    double value;    /* normalised, 0 to 1 */
} ScParamChange;

typedef struct {
    uint32_t kind;   /* SC_EVENT_NOTE_ON or SC_EVENT_NOTE_OFF */
    uint32_t offset; /* the frame in the block where it happens */
    int32_t pitch;   /* a MIDI note number */
    float velocity;  /* 0 to 1 */
} ScEvent;

typedef struct {
    uint32_t magic;
    uint32_t version;
    /* Room for a sem_t each (32 bytes on Linux x86-64 and arm64). */
    uint8_t go[64];
    uint8_t done[64];
    /* Written by the app: which block this is, and set to 1 to stop the
       helper's block thread. */
    volatile uint32_t seq;
    volatile uint32_t quit;
    /* Written by the helper when it has finished block `seq`. */
    volatile uint32_t done_seq;
    volatile uint32_t status;
    uint32_t frames;
    uint32_t param_change_count;
    uint32_t event_count;
    uint32_t reserved;
    ScParamChange param_changes[SC_MAX_PARAM_CHANGES];
    ScEvent events[SC_MAX_EVENTS];
    float in[2][SC_MAX_FRAMES];
    float out[2][SC_MAX_FRAMES];
} ScShared;
