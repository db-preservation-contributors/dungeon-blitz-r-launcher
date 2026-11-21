package
{
   import flash.display.Loader;
   import flash.events.Event;
   import flash.events.HTTPStatusEvent;
   import flash.events.IOErrorEvent;
   import flash.events.ProgressEvent;
   import flash.events.SecurityErrorEvent;
   import flash.net.URLLoader;
   import flash.net.URLLoaderDataFormat;
   import flash.net.URLRequest;
   import flash.system.LoaderContext;
   import flash.utils.ByteArray;

   /**
    * One game file on its way, for GameAssetCache. It tries its sources in order (the hashed copy,
    * the hashed copy over HTTPS, then the game's own URL) and hands the bytes to whichever Loader
    * the game is watching when they arrive.
    */
   public final class GameAssetDownload
   {
      internal var key:String;
      internal var path:String;
      internal var hashed:String;
      internal var loader:Loader;
      internal var request:URLRequest;
      internal var context:LoaderContext;

      private var sources:Array;
      private var index:int = -1;
      private var fetch:URLLoader;
      private var status:int = 0;
      private var lastBytesAt:int = 0;
      private var cancelled:Boolean = false;

      public function GameAssetDownload(key:String, path:String, hashed:String, sources:Array,
                                        loader:Loader, request:URLRequest, context:LoaderContext)
      {
         this.key = key;
         this.path = path;
         this.hashed = hashed;
         this.sources = sources;
         this.loader = loader;
         this.request = request;
         this.context = context;
      }

      /** The game started this file again on a new Loader; the bytes go there. */
      internal function retarget(loader:Loader, context:LoaderContext) : void
      {
         this.loader = loader;
         this.context = context;
      }

      internal function stalledFor() : int
      {
         return GameAssetCache.now() - lastBytesAt;
      }

      internal function cancel() : void
      {
         cancelled = true;
         stop();
      }

      /** Starts the next source, or gives up when none is left. */
      internal function next() : void
      {
         stop();
         if (cancelled)
         {
            return;
         }
         index++;
         if (index >= sources.length)
         {
            GameAssetCache.failed(this);
            return;
         }
         status = 0;
         lastBytesAt = GameAssetCache.now();
         var hashedSource:Boolean = isHashedSource();
         var source:URLRequest = hashedSource ? new URLRequest(sources[index]) : request;
         if (hashedSource)
         {
            // Kept by GameAssetCache itself; AIR's own HTTP cache would only hold a second copy.
            source.cacheResponse = false;
         }
         fetch = new URLLoader();
         fetch.dataFormat = URLLoaderDataFormat.BINARY;
         fetch.addEventListener(Event.COMPLETE, onComplete);
         fetch.addEventListener(ProgressEvent.PROGRESS, onProgress);
         fetch.addEventListener(HTTPStatusEvent.HTTP_RESPONSE_STATUS, onStatus);
         fetch.addEventListener(IOErrorEvent.IO_ERROR, onFailed);
         fetch.addEventListener(SecurityErrorEvent.SECURITY_ERROR, onFailed);
         fetch.load(source);
      }

      private function isHashedSource() : Boolean
      {
         return Boolean(hashed) && index < sources.length - 1;
      }

      private function onProgress(event:ProgressEvent) : void
      {
         lastBytesAt = GameAssetCache.now();
      }

      private function onStatus(event:HTTPStatusEvent) : void
      {
         status = event.status;
      }

      private function onComplete(event:Event) : void
      {
         if (cancelled)
         {
            return;
         }
         var bytes:ByteArray = ByteArray(fetch.data);
         var hashedSource:Boolean = isHashedSource();
         if (hashedSource && (status >= 400 || !bytes || !GameAssetCache.matches(hashed, bytes)))
         {
            GameAssetCache.log(sources[index] + " did not give " + path + " (HTTP " + status + ", " + (bytes ? bytes.length : 0) + " bytes)");
            next();
            return;
         }
         if (!hashedSource && status >= 400)
         {
            // The game's own URL answered with an error page; the game treats that as a failure.
            next();
            return;
         }
         stop();
         GameAssetCache.finished(this, bytes, hashedSource);
      }

      private function onFailed(event:Event) : void
      {
         if (cancelled)
         {
            return;
         }
         GameAssetCache.log(sources[index] + ": " + event.type);
         next();
      }

      private function stop() : void
      {
         if (!fetch)
         {
            return;
         }
         fetch.removeEventListener(Event.COMPLETE, onComplete);
         fetch.removeEventListener(ProgressEvent.PROGRESS, onProgress);
         fetch.removeEventListener(HTTPStatusEvent.HTTP_RESPONSE_STATUS, onStatus);
         fetch.removeEventListener(IOErrorEvent.IO_ERROR, onFailed);
         fetch.removeEventListener(SecurityErrorEvent.SECURITY_ERROR, onFailed);
         try
         {
            fetch.close();
         }
         catch (error:Error)
         {
         }
         fetch = null;
      }
   }
}
