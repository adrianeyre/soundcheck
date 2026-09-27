// The block of shared memory the Desktop App and one helper process pass audio
// through. `host/src/shared.rs` is the same layout in Rust; `SC_SHARED_VERSION`
// and the size check at startup keep the two in step.
//
// One block goes like this: the app writes the input audio, the parameter
// changes and the note events, bumps `seq` and posts `go`. The helper
// processes the block straight into `out`, copies `seq` to `done_seq` and posts
// `done`. The app waits for `done` only until the block's deadline, so a
// Plugin that is slow, hung or dead can never hold up the song.
//
// The spike is Linux only: the two semaphores are POSIX ones, shared between
// the processes. On Windows they would be two named events, and on macOS two
// Mach semaphores (macOS has no unnamed process-shared POSIX semaphores).
#pragma once

#include <semaphore.h>
#include <stdint.h>

#define SC_SHARED_MAGIC 0x33545356u /* "VST3" */
#define SC_SHARED_VERSION 1u
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
    sem_t go;
    sem_t done;
    /* Written by the app: which block this is, and set to 1 to stop the
       helper's audio thread. */
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
