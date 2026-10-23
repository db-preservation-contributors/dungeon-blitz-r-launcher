package
{
   import flash.desktop.NativeApplication;
   import flash.display.Loader;
   import flash.display.Sprite;
   import flash.display.StageAlign;
   import flash.display.StageScaleMode;
   import flash.events.ErrorEvent;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.events.InvokeEvent;
   import flash.events.SecurityErrorEvent;
   import flash.events.UncaughtErrorEvent;
   import flash.net.URLLoader;
   import flash.net.URLLoaderDataFormat;
   import flash.net.URLRequest;
   import flash.system.ApplicationDomain;
   import flash.system.LoaderContext;
   import flash.text.TextField;
   import flash.text.TextFieldAutoSize;
   import flash.text.TextFormat;

   /**
    * The AIR engine: Dungeon Blitz in Adobe AIR's runtime instead of Flash Player 32.
    *
    * Started as `<app> <game SWF URL> [--quality=LOW|MEDIUM|HIGH|BEST]`, it fetches the SWF and
    * runs it with loadBytes in AIR's application sandbox, with the URL's query (fv, gv, clientrev)
    * as the game's flashvars. The game's own AirCompat (the server's
    * scripts/patch-dungeonblitz-air-compat.ts) loads its level and art SWFs the same way, so the
    * whole client shares one sandbox, as it does in Flash Player.
    */
   [SWF(width="1152", height="768", backgroundColor="#484955", frameRate="60")]
   public class DungeonBlitzAir extends Sprite
   {
      private static const QUALITIES:Array = ["LOW", "MEDIUM", "HIGH", "BEST"];

      private var started:Boolean = false;
      private var status:TextField;
      private var gameUrl:String = "";

      public function DungeonBlitzAir()
      {
         stage.scaleMode = StageScaleMode.NO_SCALE;
         stage.align = StageAlign.TOP_LEFT;
         // The game's stage is 1152x768; the window's chrome goes around it.
         if (stage.nativeWindow)
         {
            stage.nativeWindow.width += 1152 - stage.stageWidth;
            stage.nativeWindow.height += 768 - stage.stageHeight;
         }
         status = new TextField();
         status.defaultTextFormat = new TextFormat("_sans", 16, 0xFFFFFF);
         status.autoSize = TextFieldAutoSize.LEFT;
         status.x = 24;
         status.y = 24;
         addChild(status);
         NativeApplication.nativeApplication.addEventListener(InvokeEvent.INVOKE, onInvoke);
      }

      private function onInvoke(event:InvokeEvent) : void
      {
         if (started)
         {
            return;
         }
         for each (var arg:String in event.arguments)
         {
            if (arg.indexOf("--quality=") == 0)
            {
               var quality:String = arg.substr(10).toUpperCase();
               if (QUALITIES.indexOf(quality) >= 0)
               {
                  stage.quality = quality;
               }
            }
            else if (/^https?:\/\//i.test(arg))
            {
               gameUrl = arg;
            }
         }
         if (!gameUrl)
         {
            say("Start Dungeon Blitz: R from the launcher.");
            return;
         }
         started = true;
         say("Loading Dungeon Blitz: R...");
         var fetch:URLLoader = new URLLoader();
         fetch.dataFormat = URLLoaderDataFormat.BINARY;
         fetch.addEventListener(Event.COMPLETE, onFetched);
         fetch.addEventListener(IOErrorEvent.IO_ERROR, onFetchFailed);
         fetch.addEventListener(SecurityErrorEvent.SECURITY_ERROR, onFetchFailed);
         fetch.load(new URLRequest(gameUrl));
      }

      private function onFetchFailed(event:ErrorEvent) : void
      {
         started = false;
         say("Could not load the game from " + gameUrl + "\n" + event.text);
      }

      private function onFetched(event:Event) : void
      {
         var context:LoaderContext = new LoaderContext(false, new ApplicationDomain(ApplicationDomain.currentDomain));
         context.allowCodeImport = true;
         context.parameters = flashVars(gameUrl);
         var loader:Loader = new Loader();
         // Release Flash Player shows nothing for an error the game does not catch; neither does this.
         loader.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR, onUncaught);
         removeChild(status);
         addChild(loader);
         loader.loadBytes(URLLoader(event.target).data, context);
      }

      private function onUncaught(event:UncaughtErrorEvent) : void
      {
         event.preventDefault();
         var error:Object = event.error;
         trace("[DungeonBlitzAir] " + (error is Error ? Error(error).getStackTrace() || Error(error).message : String(error)));
      }

      private static function flashVars(url:String) : Object
      {
         var vars:Object = {};
         var origin:Array = url.match(/^https?:\/\/[^\/?#]+/i);
         if (origin)
         {
            vars.origin = origin[0];
         }
         var query:int = url.indexOf("?");
         if (query < 0)
         {
            return vars;
         }
         for each (var pair:String in url.substr(query + 1).split("#")[0].split("&"))
         {
            var eq:int = pair.indexOf("=");
            var key:String = decodeURIComponent(eq < 0 ? pair : pair.substr(0, eq));
            if (key)
            {
               vars[key] = eq < 0 ? "" : decodeURIComponent(pair.substr(eq + 1).replace(/\+/g, " "));
            }
         }
         return vars;
      }

      private function say(text:String) : void
      {
         status.text = text;
      }
   }
}
