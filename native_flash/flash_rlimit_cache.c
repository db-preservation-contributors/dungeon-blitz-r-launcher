/*
 * flash_rlimit_cache.so -- answers the Linux Flash Player's getrlimit() from memory.
 *
 * The standalone Flash Player calls getrlimit() from its main thread over and over while the
 * game plays, many times per frame. Each call is a system call, and on a kernel that
 * mitigates SRSO (AMD Zen 1 to 4, on by default) a system call costs about 200 ns. Profiled
 * in a dungeon on a Ryzen 7 3700X, the main thread spent about 40% of its time in that one
 * call, and the game ran at 15-30 fps; with this library, roughly 30-60 fps
 *
 * A process's limits only change when it sets them, so the first answer for each resource
 * is kept and handed back after that; setrlimit() forgets the kept one. The launcher loads
 * this library into Flash Player with LD_PRELOAD (lib/projector.js), and Flash Player
 * imports getrlimit from libc, so its calls land here.
 *
 * It talks to the kernel with syscall(2) rather than looking up libc's own getrlimit with
 * dlsym: dlsym moved into libc with a newer symbol version in glibc 2.34, and a library
 * built on a recent system would then not load on an older one. syscall() has been in
 * every glibc since 2.2.5. tools/build-flash-preload.js checks that nothing newer is
 * needed.
 */
#define _GNU_SOURCE
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

static struct rlimit kept[RLIM_NLIMITS];
static int known[RLIM_NLIMITS];

static int ask_kernel(int resource, const struct rlimit *set, struct rlimit *get)
{
    /* What glibc's getrlimit and setrlimit do on x86_64: prlimit64 on this process. */
    return (int)syscall(SYS_prlimit64, 0, resource, set, get);
}

static int cached_getrlimit(int resource, struct rlimit *rlim)
{
    unsigned index = (unsigned)resource;
    if (index >= RLIM_NLIMITS) {
        return ask_kernel(resource, NULL, rlim);
    }
    if (__atomic_load_n(&known[index], __ATOMIC_ACQUIRE)) {
        *rlim = kept[index];
        return 0;
    }
    int result = ask_kernel(resource, NULL, rlim);
    if (result == 0) {
        kept[index] = *rlim;
        __atomic_store_n(&known[index], 1, __ATOMIC_RELEASE);
    }
    return result;
}

static int forgetting_setrlimit(int resource, const struct rlimit *rlim)
{
    unsigned index = (unsigned)resource;
    if (index < RLIM_NLIMITS) {
        __atomic_store_n(&known[index], 0, __ATOMIC_RELEASE);
    }
    return ask_kernel(resource, rlim, NULL);
}

/* struct rlimit and struct rlimit64 are the same on x86_64, as are the two names. */
int getrlimit(__rlimit_resource_t resource, struct rlimit *rlim)
{
    return cached_getrlimit(resource, rlim);
}

int getrlimit64(__rlimit_resource_t resource, struct rlimit64 *rlim)
{
    return cached_getrlimit(resource, (struct rlimit *)rlim);
}

int setrlimit(__rlimit_resource_t resource, const struct rlimit *rlim)
{
    return forgetting_setrlimit(resource, rlim);
}

int setrlimit64(__rlimit_resource_t resource, const struct rlimit64 *rlim)
{
    return forgetting_setrlimit(resource, (const struct rlimit *)rlim);
}
