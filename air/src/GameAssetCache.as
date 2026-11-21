package
{
   import flash.display.Loader;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.events.SecurityErrorEvent;
   import flash.events.TimerEvent;
   import flash.filesystem.File;
   import flash.filesystem.FileMode;
   import flash.filesystem.FileStream;
   import flash.net.URLLoader;
   import flash.net.URLLoaderDataFormat;
   import flash.net.URLRequest;
   import flash.system.ApplicationDomain;
   import flash.system.LoaderContext;
   import flash.utils.ByteArray;
   import flash.utils.Timer;
   import flash.utils.getTimer;

   /**
    * The level and art SWFs the game loads, kept on disk by content hash.
    *
    * The game's own file URLs (/p/cbp/LevelsNR.swf, ...) are not versioned, so the server sends them
    * "no-cache, must-revalidate", and every start asked the server for every file again. The game
    * server also publishes /asset-manifest.json, which names each file by its content hash and serves
    * it at /_h/<hash><ext> for good. With that manifest a file whose hash is on disk loads with no
    * request at all, and a new or changed file is downloaded once, checked against its hash and kept.
    *
    * It also fixes the game's own restart loop in AIR. The game restarts a download that reports no
    * progress for 10 s (+5 s per attempt), with ?v=<attempt> on the URL. In AIR the game's AirCompat
    * fetches a SWF with a URLLoader and hands the bytes to the Loader only at the end, so the Loader
    * the game watches shows no progress until the whole file is in. On a slow connection every file
    * that takes longer than that was restarted, and each restart started one more download of it
    * beside the ones still running (closing the Loader does not stop the URLLoader), so the file got
    * slower with every attempt and never finished: the loading screen's "R=50". Here a restart of a
    * file that is still downloading joins that download, and the bytes go to the Loader the game is
    * watching now. Only a download that has had no bytes for STALL_MS is started again.
    *
    * Files the manifest does not name (the game SWF, Game.swz, masterFileList.xml: the server
    * computes those) and files from another host are not kept, but their restarts still join.
    */
   public final class GameAssetCache
   {
      /** The game's ApplicationDomain; a loaded SWF goes in a child of it, as with the game's own AirCompat. */
      public static var gameDomain:ApplicationDomain;

      /** A download with no bytes for this long is started again when the game asks for it again. */
      internal static const STALL_MS:int = 20000;
      private static const MANIFEST_TIMEOUT_MS:int = 15000;
      private static const FOLDER:String = "game-files";
      private static const MANIFEST_FILE:String = "asset-manifest.json";
      private static const HASH_LENGTH:int = 32;
      private static const HASHED_NAME:RegExp = /^[0-9a-f]{32}\.[0-9a-z]{1,8}$/;

      private static const NONE:int = 0;
      private static const LOADING:int = 1;
      private static const READY:int = 2;

      private static var state:int = NONE;
      private static var host:String = "";
      private static var folder:File;
      /** Game path ("/p/cbp/LevelsNR.swf") -> hashed name ("<32 hex>.swf"), or null. */
      private static var files:Object;
      private static var manifestFetch:URLLoader;
      private static var manifestTimer:Timer;
      /** Loads asked for while the manifest is still on its way: [loader, request, context]. */
      private static var waiting:Array = [];
      /** "host/path" -> the download of that file now running. */
      private static var running:Object = {};

      /** Fetches the manifest of the server `gameUrl` is on. Loads asked for before it arrives wait for it. */
      public static function start(gameUrl:String) : void
      {
         var parts:Object = split(gameUrl);
         if (!parts || state != NONE)
         {
            return;
         }
         host = parts.host;
         try
         {
            folder = File.applicationStorageDirectory.resolvePath(FOLDER).resolvePath(host.replace(/[^A-Za-z0-9._-]+/g, "_"));
            folder.createDirectory();
         }
         catch (error:Error)
         {
            log("no folder for game files: " + error.message);
            folder = null;
         }
         state = LOADING;
         var request:URLRequest = new URLRequest(parts.base + "/" + MANIFEST_FILE);
         request.useCache = false;
         request.cacheResponse = false;
         manifestFetch = new URLLoader();
         manifestFetch.dataFormat = URLLoaderDataFormat.TEXT;
         manifestFetch.addEventListener(Event.COMPLETE, onManifest);
         manifestFetch.addEventListener(IOErrorEvent.IO_ERROR, onManifestFailed);
         manifestFetch.addEventListener(SecurityErrorEvent.SECURITY_ERROR, onManifestFailed);
         manifestTimer = new Timer(MANIFEST_TIMEOUT_MS, 1);
         manifestTimer.addEventListener(TimerEvent.TIMER_COMPLETE, onManifestFailed);
         manifestTimer.start();
         manifestFetch.load(request);
      }

      /** AirCompat.Load in AIR. */
      public static function load(loader:Loader, request:URLRequest, context:LoaderContext) : void
      {
         var parts:Object = split(request.url);
         if (!parts)
         {
            fetchDirect(loader, request, context);
            return;
         }
         var key:String = parts.host + parts.path;
         var download:GameAssetDownload = running[key];
         if (download)
         {
            if (download.stalledFor() < STALL_MS)
            {
               // The game restarted a file that is still coming in: the bytes go to its new Loader.
               log(parts.path + ": asked again while downloading; joining that download");
               download.retarget(loader, context);
               return;
            }
            log(parts.path + ": no bytes for " + int(download.stalledFor() / 1000) + " s; downloading it again");
            download.cancel();
            delete running[key];
         }
         if (state == LOADING && parts.host == host)
         {
            waiting.push([loader, request, context]);
            return;
         }
         begin(loader, request, context, parts, key);
      }

      private static function begin(loader:Loader, request:URLRequest, context:LoaderContext, parts:Object, key:String) : void
      {
         var hashed:String = parts.host == host ? hashedName(parts.path) : null;
         if (hashed)
         {
            var kept:ByteArray = readKept(hashed);
            if (kept)
            {
               log(parts.path + ": from disk");
               deliver(loader, kept, context, hashed);
               return;
            }
         }
         var sources:Array = [];
         if (hashed)
         {
            sources.push(parts.base + "/_h/" + hashed);
            if (parts.base.indexOf("http://") == 0)
            {
               // Plain HTTP can be answered by something else; the hash says whether HTTPS got the file.
               sources.push("https://" + parts.base.substr(7) + "/_h/" + hashed);
            }
         }
         sources.push(request.url);
         var download:GameAssetDownload = new GameAssetDownload(key, parts.path, hashed, sources, loader, request, context);
         running[key] = download;
         download.next();
      }

      // ---- what a download reports -------------------------------------------------------------

      internal static function finished(download:GameAssetDownload, bytes:ByteArray, fromHashedSource:Boolean) : void
      {
         if (running[download.key] === download)
         {
            delete running[download.key];
         }
         log(download.path + ": downloaded, " + bytes.length + " bytes" + (download.hashed && fromHashedSource ? ", kept" : ""));
         if (download.hashed && fromHashedSource)
         {
            keep(download.hashed, bytes);
         }
         deliver(download.loader, bytes, download.context, null);
      }

      internal static function failed(download:GameAssetDownload) : void
      {
         if (running[download.key] === download)
         {
            delete running[download.key];
         }
         log(download.path + ": could not be downloaded; the game will ask again");
         // As the game's own AirCompat does when its download fails.
         download.loader.load(download.request, download.context);
      }

      /** True when `bytes` are the file the hashed name was made from. */
      internal static function matches(hashed:String, bytes:ByteArray) : Boolean
      {
         return Sha256.hex(bytes).substr(0, HASH_LENGTH) == hashed.substr(0, HASH_LENGTH);
      }

      internal static function log(message:String) : void
      {
         trace("[GameAssetCache] " + message);
      }

      // ---- the manifest ------------------------------------------------------------------------

      private static function onManifest(event:Event) : void
      {
         var parsed:Object = parseManifest(String(manifestFetch.data));
         if (!parsed)
         {
            onManifestFailed(event);
            return;
         }
         stopManifestFetch();
         files = parsed;
         writeText(MANIFEST_FILE, String(manifestFetch.data));
         prune();
         ready();
      }

      private static function onManifestFailed(event:Event) : void
      {
         stopManifestFetch();
         // The last manifest this server sent: its files are still the right bytes for their hashes,
         // and on a connection too poor to fetch the manifest, the game is better off playing them.
         files = parseManifest(readText(MANIFEST_FILE));
         log("the manifest could not be fetched (" + event.type + "); " + (files ? "using the last one" : "keeping nothing this time"));
         ready();
      }

      private static function stopManifestFetch() : void
      {
         if (manifestTimer)
         {
            manifestTimer.stop();
            manifestTimer.removeEventListener(TimerEvent.TIMER_COMPLETE, onManifestFailed);
            manifestTimer = null;
         }
         if (manifestFetch)
         {
            manifestFetch.removeEventListener(Event.COMPLETE, onManifest);
            manifestFetch.removeEventListener(IOErrorEvent.IO_ERROR, onManifestFailed);
            manifestFetch.removeEventListener(SecurityErrorEvent.SECURITY_ERROR, onManifestFailed);
            try
            {
               manifestFetch.close();
            }
            catch (error:Error)
            {
            }
         }
      }

      private static function ready() : void
      {
         state = READY;
         var queued:Array = waiting;
         waiting = [];
         for each (var entry:Array in queued)
         {
            load(entry[0], entry[1], entry[2]);
         }
      }

      private static function parseManifest(text:String) : Object
      {
         if (!text)
         {
            return null;
         }
         try
         {
            var manifest:Object = JSON.parse(text);
            if (manifest && manifest.prefix == "/_h/" && manifest.files is Object)
            {
               return manifest.files;
            }
         }
         catch (error:Error)
         {
         }
         return null;
      }

      private static function hashedName(path:String) : String
      {
         if (!files)
         {
            return null;
         }
         var name:String = files[path];
         if (!name)
         {
            try
            {
               name = files[decodeURI(path)];
            }
            catch (error:Error)
            {
            }
         }
         return name && HASHED_NAME.test(name) ? name : null;
      }

      // ---- the disk ----------------------------------------------------------------------------

      private static function readKept(hashed:String) : ByteArray
      {
         if (!folder)
         {
            return null;
         }
         try
         {
            var file:File = folder.resolvePath(hashed);
            if (!file.exists || file.size == 0)
            {
               return null;
            }
            var bytes:ByteArray = new ByteArray();
            var stream:FileStream = new FileStream();
            stream.open(file, FileMode.READ);
            stream.readBytes(bytes);
            stream.close();
            return bytes;
         }
         catch (error:Error)
         {
            log(hashed + " could not be read: " + error.message);
         }
         return null;
      }

      private static function keep(hashed:String, bytes:ByteArray) : void
      {
         if (!folder)
         {
            return;
         }
         try
         {
            // Written beside its name and moved in, so a half-written file is never read.
            var partial:File = folder.resolvePath(hashed + ".part");
            var stream:FileStream = new FileStream();
            stream.open(partial, FileMode.WRITE);
            stream.writeBytes(bytes);
            stream.close();
            partial.moveTo(folder.resolvePath(hashed), true);
         }
         catch (error:Error)
         {
            // It still plays; it is only downloaded again next time.
            log(hashed + " could not be kept: " + error.message);
         }
      }

      /** A kept file the game could not load is dropped, so the next attempt downloads it again. */
      private static function forget(hashed:String) : void
      {
         try
         {
            var file:File = folder.resolvePath(hashed);
            if (file.exists)
            {
               file.deleteFile();
            }
         }
         catch (error:Error)
         {
         }
      }

      /** Drops kept files the current manifest no longer names: old versions of changed files. */
      private static function prune() : void
      {
         if (!folder || !files)
         {
            return;
         }
         var current:Object = {};
         for each (var name:String in files)
         {
            current[name] = true;
         }
         try
         {
            for each (var file:File in folder.getDirectoryListing())
            {
               if (file.name != MANIFEST_FILE && !current[file.name])
               {
                  file.deleteFile();
               }
            }
         }
         catch (error:Error)
         {
            log("old game files could not be removed: " + error.message);
         }
      }

      private static function readText(name:String) : String
      {
         if (!folder)
         {
            return null;
         }
         try
         {
            var file:File = folder.resolvePath(name);
            if (!file.exists)
            {
               return null;
            }
            var stream:FileStream = new FileStream();
            stream.open(file, FileMode.READ);
            var text:String = stream.readUTFBytes(stream.bytesAvailable);
            stream.close();
            return text;
         }
         catch (error:Error)
         {
         }
         return null;
      }

      private static function writeText(name:String, text:String) : void
      {
         if (!folder)
         {
            return;
         }
         try
         {
            var partial:File = folder.resolvePath(name + ".part");
            var stream:FileStream = new FileStream();
            stream.open(partial, FileMode.WRITE);
            stream.writeUTFBytes(text);
            stream.close();
            partial.moveTo(folder.resolvePath(name), true);
         }
         catch (error:Error)
         {
         }
      }

      // ---- handing the bytes to the game -------------------------------------------------------

      private static function deliver(loader:Loader, bytes:ByteArray, context:LoaderContext, keptAs:String) : void
      {
         var ctx:LoaderContext = context ? context : new LoaderContext();
         if (!ctx.applicationDomain && gameDomain)
         {
            // The game's AirCompat called loadBytes from the game's own domain, which put the file
            // in a child of it; called from here, the default would be a child of this app's.
            ctx.applicationDomain = new ApplicationDomain(gameDomain);
         }
         ctx["allowCodeImport"] = true;
         if (keptAs)
         {
            loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(event:Event) : void
            {
               log(keptAs + " on disk did not load; dropping it");
               forget(keptAs);
            }, false, 0, true);
         }
         loader.loadBytes(bytes, ctx);
      }

      /** A request the cache cannot place: what the game's own AirCompat did. */
      private static function fetchDirect(loader:Loader, request:URLRequest, context:LoaderContext) : void
      {
         var fetch:URLLoader = new URLLoader();
         fetch.dataFormat = URLLoaderDataFormat.BINARY;
         var fallback:Function = function(event:Event) : void
         {
            loader.load(request, context);
         };
         fetch.addEventListener(Event.COMPLETE, function(event:Event) : void
         {
            deliver(loader, ByteArray(fetch.data), context, null);
         });
         fetch.addEventListener(IOErrorEvent.IO_ERROR, fallback);
         fetch.addEventListener(SecurityErrorEvent.SECURITY_ERROR, fallback);
         fetch.load(request);
      }

      /** "http://host:port/p/a.swf?v=2" -> {base: "http://host:port", host: "host:port", path: "/p/a.swf"}. */
      internal static function split(url:String) : Object
      {
         var match:Object = /^(https?):\/\/([^\/?#]+)([^?#]*)/i.exec(url || "");
         if (!match)
         {
            return null;
         }
         var where:String = String(match[2]).toLowerCase();
         return { base: String(match[1]).toLowerCase() + "://" + where, host: where, path: match[3] || "/" };
      }

      internal static function now() : int
      {
         return getTimer();
      }
   }
}
