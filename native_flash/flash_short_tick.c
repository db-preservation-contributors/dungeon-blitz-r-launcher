/*
 * flash_short_tick.so -- lets the Linux Flash Player pick its work back up sooner.
 *
 * The standalone Flash Player paces itself with GLib timers of 10 ms, three of them, set up
 * with g_timeout_add() at start. A step of its frame only begins on a tick, so a frame that
 * runs a little past one tick waits for the next: in game, frame times came in two bands,
 * one tick (10-14 ms) and two (18-24 ms), and Flash Player's main thread spent about a
 * quarter of its time waiting in GLib's main loop.
 *
 * Here those 10 ms timers tick every 2 ms instead. Flash Player still decides on its own
 * clock when a frame is due, so the game keeps its speed and its 100 fps cap; it only stops
 * waiting for a tick it no longer needs. Standing still in the same spot of a dungeon, on a
 * Ryzen 7 3700X, full screen at high quality: 78.5 fps before, 85.3 fps after, with the
 * two-tick frames down from 21% to 0.5%. Timers of any other length are left alone.
 *
 * g_timeout_add() is GLib's g_timeout_add_full() at the default priority, so this one calls
 * that rather than looking up GLib's own with dlsym (see flash_rlimit_cache.c for why not).
 * The reference is weak: a program without GLib that inherits LD_PRELOAD from Flash Player
 * still starts, even with LD_BIND_NOW, and never calls it.
 */
typedef int (*GSourceFunc)(void *data);
typedef void (*GDestroyNotify)(void *data);

extern unsigned int g_timeout_add_full(int priority, unsigned int interval, GSourceFunc function, void *data,
                                       GDestroyNotify notify) __attribute__((weak));

#define G_PRIORITY_DEFAULT 0
#define FLASH_TICK_MS 10
#define SHORT_TICK_MS 2

unsigned int g_timeout_add(unsigned int interval, GSourceFunc function, void *data)
{
    if (interval == FLASH_TICK_MS) {
        interval = SHORT_TICK_MS;
    }
    return g_timeout_add_full(G_PRIORITY_DEFAULT, interval, function, data, 0);
}
