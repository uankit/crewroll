#ifndef CREWROLL_FIXTURE_RNG_H
#define CREWROLL_FIXTURE_RNG_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

int cr_fixture_rng_install(void);
void cr_fixture_rng_reset(void);
size_t cr_fixture_rng_bytes_consumed(void);
int cr_fixture_rng_was_exhausted(void);
const char *cr_fixture_rng_name(void);
void cr_fixture_rng_exhaust_for_test(void);

#ifdef __cplusplus
}
#endif

#endif
