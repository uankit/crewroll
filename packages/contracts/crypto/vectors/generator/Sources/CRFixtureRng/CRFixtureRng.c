#include "CRFixtureRng.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <Clibsodium/sodium.h>

#define CR_TAPE_BLOCK                                                         \
    0x13, 0x57, 0x9b, 0xdf, 0x24, 0x68, 0xac, 0xf0,                         \
    0x31, 0x75, 0xb9, 0xfd, 0x46, 0x8a, 0xce, 0x02,                         \
    0x5d, 0xa1, 0xe5, 0x29, 0x6e, 0xb2, 0xf6, 0x3a,                         \
    0x7f, 0xc3, 0x07, 0x4b, 0x90, 0xd4, 0x18, 0x5c

static const unsigned char cr_entropy_tape[] = {
    CR_TAPE_BLOCK, CR_TAPE_BLOCK, CR_TAPE_BLOCK, CR_TAPE_BLOCK,
    CR_TAPE_BLOCK, CR_TAPE_BLOCK, CR_TAPE_BLOCK, CR_TAPE_BLOCK,
    CR_TAPE_BLOCK, CR_TAPE_BLOCK, CR_TAPE_BLOCK, CR_TAPE_BLOCK,
    CR_TAPE_BLOCK, CR_TAPE_BLOCK, CR_TAPE_BLOCK, CR_TAPE_BLOCK,
};

static size_t cr_entropy_offset = 0;
static int cr_entropy_exhausted = 0;

static const char *cr_name(void) {
    return "crewroll-fixture-v1-do-not-ship";
}

static void cr_take(void *const output, const size_t size) {
    if (size > sizeof cr_entropy_tape - cr_entropy_offset) {
        cr_entropy_exhausted = 1;
        abort();
    }
    memcpy(output, cr_entropy_tape + cr_entropy_offset, size);
    cr_entropy_offset += size;
}

static uint32_t cr_random(void) {
    uint32_t value = 0;
    cr_take(&value, sizeof value);
    return value;
}

static void cr_stir(void) {
}

static void cr_buf(void *const output, const size_t size) {
    cr_take(output, size);
}

static int cr_close(void) {
    return 0;
}

static randombytes_implementation cr_implementation = {
    cr_name,
    cr_random,
    cr_stir,
    NULL,
    cr_buf,
    cr_close,
};

int cr_fixture_rng_install(void) {
    cr_fixture_rng_reset();
    return randombytes_set_implementation(&cr_implementation);
}

void cr_fixture_rng_reset(void) {
    cr_entropy_offset = 0;
    cr_entropy_exhausted = 0;
}

size_t cr_fixture_rng_bytes_consumed(void) {
    return cr_entropy_offset;
}

int cr_fixture_rng_was_exhausted(void) {
    return cr_entropy_exhausted;
}

const char *cr_fixture_rng_name(void) {
    return cr_name();
}

void cr_fixture_rng_exhaust_for_test(void) {
    unsigned char output[sizeof cr_entropy_tape + 1];
    cr_fixture_rng_reset();
    randombytes_buf(output, sizeof output);
}
