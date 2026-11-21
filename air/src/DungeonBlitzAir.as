package
{
   import flash.desktop.NativeApplication;
   import flash.display.Bitmap;
   import flash.display.DisplayObject;
   import flash.display.GradientType;
   import flash.display.Graphics;
   import flash.display.Loader;
   import flash.display.Sprite;
   import flash.display.StageAlign;
   import flash.display.StageDisplayState;
   import flash.display.StageScaleMode;
   import flash.events.ErrorEvent;
   import flash.events.Event;
   import flash.events.FullScreenEvent;
   import flash.events.HTTPStatusEvent;
   import flash.events.IOErrorEvent;
   import flash.events.InvokeEvent;
   import flash.events.KeyboardEvent;
   import flash.events.MouseEvent;
   import flash.events.ProgressEvent;
   import flash.events.SecurityErrorEvent;
   import flash.events.TimerEvent;
   import flash.events.UncaughtErrorEvent;
   import flash.filesystem.File;
   import flash.filesystem.FileMode;
   import flash.filesystem.FileStream;
   import flash.net.URLLoader;
   import flash.net.URLLoaderDataFormat;
   import flash.net.URLRequest;
   import flash.system.ApplicationDomain;
   import flash.geom.Matrix;
   import flash.system.LoaderContext;
   import flash.text.AntiAliasType;
   import flash.text.Font;
   import flash.text.TextField;
   import flash.text.TextFieldAutoSize;
   import flash.text.TextFormat;
   import flash.text.TextFormatAlign;
   import flash.ui.Keyboard;
   import flash.utils.ByteArray;
   import flash.utils.Timer;

   /**
    * The AIR engine: Dungeon Blitz in Adobe AIR's runtime instead of Flash Player 32.
    *
    * Started as `<app> <game SWF URL> [--quality=LOW|MEDIUM|HIGH|BEST]`, it runs the game SWF
    * with loadBytes in AIR's application sandbox, with the URL's query (fv, gv, clientrev) as the
    * game's flashvars. The game's own AirCompat (the server's
    * scripts/patch-dungeonblitz-air-compat.ts) loads its level and art SWFs the same way, so the
    * whole client shares one sandbox, as it does in Flash Player.
    *
    * The game SWF is kept on disk (client-cache/ in the app's storage folder), named after the
    * whole URL. The URL's clientrev is the SWF's own content hash (the game server's StaticServer
    * derives it), so a new client build is a new name: a start whose file is already there plays
    * it without asking the server for it, and a new build is downloaded once and replaces the old
    * one. A URL without a clientrev is never cached.
    *
    * The level and art SWFs the game loads are kept on disk too, by content hash, and a file the
    * game restarts while it is still downloading is not downloaded twice: see GameAssetCache, and
    * AirCompat for how the game's loads reach it.
    *
    * While the SWF downloads, a loading screen shows its progress. When it cannot be had, an error
    * screen says what happened in a player's words, with Try again (and an automatic retry) and
    * the technical detail underneath. Both wear theminesa.studio/dungeon-blitz-r.html's look, as
    * the launcher window does: its hero art, its ornament and title, Averia Serif Libre and
    * Vollkorn SC (embedded from assets/, converted from renderer/assets/fonts/), and its colours.
    *
    * The standard window chrome has no full-screen button on Windows (macOS has its green one), so
    * F11, Alt+Enter, Ctrl+F (Cmd+F) and a small button in the top-right corner toggle full screen, and the game
    * lays itself out to fill it, as in Flash Player's full screen.
    */
   [SWF(width="1152", height="768", backgroundColor="#070707", frameRate="60")]
   public class DungeonBlitzAir extends Sprite
   {
      private static const QUALITIES:Array = ["LOW", "MEDIUM", "HIGH", "BEST"];
      private static const CACHE_FOLDER:String = "client-cache";
      /** Seconds before an error screen tries again by itself. */
      private static const RETRY_SECONDS:int = 20;
      private static const BAR_WIDTH:int = 420;
      private static const COLUMN:int = 640;

      // theminesa.studio/dungeon-blitz-r.html
      private static const INK:uint = 0x070707;
      private static const WHITE:uint = 0xFFFFFF;
      private static const GOLD:uint = 0xEAC06B;
      private static const CREAM:uint = 0xE0CDA7;
      private static const MUTED:uint = 0xA8978A;
      private static const RED:uint = 0xA84B4B;
      private static const DARK:uint = 0x140B08;

      // DungeonBlitz.swf's own background, which Flash Player and the site's page show around the
      // game. A loaded SWF's background is not the stage's, so the stage takes it when the game runs:
      // in full screen the game keeps its size and the rest of the screen is this colour.
      private static const GAME_BACKGROUND:uint = 0x484955;

      private static const DISPLAY:String = "Averia Serif Libre";
      private static const UI:String = "Vollkorn SC";

      [Embed(source="../assets/averia-serif-libre-400.ttf", fontName="Averia Serif Libre", fontWeight="normal", embedAsCFF="false", mimeType="application/x-font")]
      private static const AveriaRegular:Class;
      [Embed(source="../assets/averia-serif-libre-700.ttf", fontName="Averia Serif Libre", fontWeight="bold", embedAsCFF="false", mimeType="application/x-font")]
      private static const AveriaBold:Class;
      [Embed(source="../assets/vollkorn-sc-600.ttf", fontName="Vollkorn SC", fontWeight="normal", embedAsCFF="false", mimeType="application/x-font")]
      private static const VollkornSemibold:Class;
      [Embed(source="../assets/vollkorn-sc-700.ttf", fontName="Vollkorn SC", fontWeight="bold", embedAsCFF="false", mimeType="application/x-font")]
      private static const VollkornBold:Class;
      [Embed(source="../assets/background.jpg")]
      private static const Backdrop:Class;

      private var started:Boolean = false;
      private var gameUrl:String = "";
      private var game:Loader;
      private var fullScreenButton:Sprite;
      private var fetch:URLLoader;
      private var httpStatus:int = 0;

      private var screen:Sprite;
      private var backdrop:Bitmap;
      private var shade:Sprite;
      private var ornamentTop:Sprite;
      private var ornamentBottom:Sprite;
      private var gameTitle:TextField;
      private var screenTitle:TextField;
      private var screenBody:TextField;
      private var screenDetail:TextField;
      private var credit:TextField;
      private var progressTrack:Sprite;
      private var progressFill:Sprite;
      /** 0..1, or below 0 for a bar with no amount (the kept game is starting). */
      private var progress:Number = -1;
      private var buttons:Sprite;
      private var retryTimer:Timer;
      private var retryLeft:int = 0;
      private var errorBody:String = "";

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
         buildScreen();
         // Capture phase, so the key still toggles while the game's own input has focus.
         fullScreenButton = new Sprite();
         fullScreenButton.buttonMode = true;
         fullScreenButton.alpha = 0.4;
         fullScreenButton.addEventListener(MouseEvent.CLICK, onFullScreenClick);
         fullScreenButton.addEventListener(MouseEvent.ROLL_OVER, onButtonHover);
         fullScreenButton.addEventListener(MouseEvent.ROLL_OUT, onButtonHover);
         stage.addEventListener(KeyboardEvent.KEY_DOWN, onKeyDown, true, 1000);
         stage.addEventListener(Event.RESIZE, fitGame);
         stage.addEventListener(FullScreenEvent.FULL_SCREEN, fitGame);
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
            showMessage("Open Dungeon Blitz: R from the launcher", "This window runs the game; the launcher is what starts it.");
            return;
         }
         started = true;
         loadGame();
      }

      // ---- getting the game SWF ----------------------------------------------------------------

      private function loadGame() : void
      {
         stopRetryTimer();
         // The level and art files' manifest, fetched while the game SWF is read or downloaded.
         GameAssetCache.start(gameUrl);
         var cached:ByteArray = readCached();
         if (cached)
         {
            showLoading("Starting Dungeon Blitz: R...", -1);
            runGame(cached);
            return;
         }
         showLoading("Downloading the game...", 0);
         httpStatus = 0;
         fetch = new URLLoader();
         fetch.dataFormat = URLLoaderDataFormat.BINARY;
         fetch.addEventListener(Event.COMPLETE, onFetched);
         fetch.addEventListener(ProgressEvent.PROGRESS, onFetchProgress);
         fetch.addEventListener(HTTPStatusEvent.HTTP_RESPONSE_STATUS, onHttpStatus);
         fetch.addEventListener(IOErrorEvent.IO_ERROR, onFetchFailed);
         fetch.addEventListener(SecurityErrorEvent.SECURITY_ERROR, onFetchFailed);
         fetch.load(new URLRequest(gameUrl));
      }

      private function onHttpStatus(event:HTTPStatusEvent) : void
      {
         httpStatus = event.status;
      }

      private function onFetchProgress(event:ProgressEvent) : void
      {
         if (event.bytesTotal > 0)
         {
            progress = Math.max(0, Math.min(1, event.bytesLoaded / event.bytesTotal));
            drawProgress();
         }
      }

      private function onFetchFailed(event:ErrorEvent) : void
      {
         showFetchError("Error #" + event.errorID + (httpStatus > 0 ? " - HTTP " + httpStatus : ""));
      }

      /** In a player's words, by what the server answered; AIR completes a 4xx/5xx with its body. */
      private function showFetchError(technical:String) : void
      {
         var detail:String = technical + "\n" + gameUrl;
         if (httpStatus >= 500)
         {
            showError("The game server is busy", "It did not send the game this time. It may be restarting; this usually passes within a few minutes.", detail);
         }
         else if (httpStatus >= 400)
         {
            showError("The game could not be found", "The server does not have this version of the game. Restart the launcher to get the current one.", detail);
         }
         else if (httpStatus >= 200 && httpStatus < 300)
         {
            showError("The game did not download correctly", "The server sent something other than the game. Try again in a moment.", detail);
         }
         else
         {
            showError("Could not reach the game server", "Check your internet connection. If it works, the server may be down for a moment.", detail);
         }
      }

      private function onFetched(event:Event) : void
      {
         var bytes:ByteArray = ByteArray(fetch.data);
         if (httpStatus < 400 && !looksLikeSwf(bytes) && /^http:\/\//i.test(gameUrl))
         {
            // Plain HTTP can be answered by someone else's page (a network filter, a captive
            // portal) with a 200; the same address over HTTPS reaches the game server.
            gameUrl = gameUrl.replace(/^http:/i, "https:");
            loadGame();
            return;
         }
         if (httpStatus >= 400 || !looksLikeSwf(bytes))
         {
            showFetchError((httpStatus > 0 ? "HTTP " + httpStatus + " - " : "") + bytes.length + " bytes");
            return;
         }
         writeCached(bytes);
         runGame(bytes);
      }

      private function runGame(bytes:ByteArray) : void
      {
         var context:LoaderContext = new LoaderContext(false, gameDomain(bytes));
         context.allowCodeImport = true;
         context.parameters = flashVars(gameUrl);
         var loader:Loader = new Loader();
         game = loader;
         // Release Flash Player shows nothing for an error the game does not catch; neither does this.
         loader.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR, onUncaught);
         if (screen.parent)
         {
            removeChild(screen);
         }
         stage.color = GAME_BACKGROUND;
         addChild(loader);
         // Above the game, which is a sibling of it and gets no click this button takes.
         addChild(fullScreenButton);
         loader.loadBytes(bytes, context);
         fitGame();
      }

      /**
       * Where the game runs. A child of this app's domain sees this app's AirCompat instead of its
       * own, which sends its level and art files through GameAssetCache; that is only done for a
       * game whose AirCompat is the one this app's copy was made from. Any other game runs in a
       * domain of its own, with its own AirCompat, as it would in Flash Player.
       */
      private static function gameDomain(bytes:ByteArray) : ApplicationDomain
      {
         if (carries(bytes, AirCompat.SOURCE_DIGEST))
         {
            GameAssetCache.gameDomain = new ApplicationDomain(ApplicationDomain.currentDomain);
            return GameAssetCache.gameDomain;
         }
         trace("[DungeonBlitzAir] the game's AirCompat is not " + AirCompat.SOURCE_DIGEST + "; game files are not kept");
         return new ApplicationDomain(null);
      }

      /** True when the SWF's code (FWS, or CWS once inflated) contains `text`. */
      private static function carries(swf:ByteArray, text:String) : Boolean
      {
         if (!swf || swf.length < 8 || swf[1] != 0x57 || swf[2] != 0x53)
         {
            return false;
         }
         var body:ByteArray = new ByteArray();
         body.writeBytes(swf, 8);
         if (swf[0] == 0x43)
         {
            try
            {
               body.uncompress();
            }
            catch (error:Error)
            {
               return false;
            }
         }
         else if (swf[0] != 0x46)
         {
            return false;
         }
         var needle:ByteArray = new ByteArray();
         needle.writeUTFBytes(text);
         var first:int = needle[0];
         var last:int = body.length - needle.length;
         for (var at:int = 0; at <= last; at++)
         {
            if (body[at] != first)
            {
               continue;
            }
            var i:int = 1;
            while (i < needle.length && body[at + i] == needle[i])
            {
               i++;
            }
            if (i == needle.length)
            {
               return true;
            }
         }
         return false;
      }

      // ---- the disk cache ----------------------------------------------------------------------

      /** The file this URL is kept in, or null for a URL without a clientrev. */
      private function cacheFile() : File
      {
         if (!/[?&]clientrev=[^&#]+/.test(gameUrl))
         {
            return null;
         }
         var name:String = gameUrl.replace(/^https?:\/\//i, "").replace(/[^A-Za-z0-9._-]+/g, "_");
         if (name.length > 180)
         {
            name = name.substr(name.length - 180);
         }
         return File.applicationStorageDirectory.resolvePath(CACHE_FOLDER).resolvePath(name + ".swf");
      }

      private function readCached() : ByteArray
      {
         var file:File = cacheFile();
         if (!file || !file.exists)
         {
            return null;
         }
         try
         {
            var bytes:ByteArray = new ByteArray();
            var stream:FileStream = new FileStream();
            stream.open(file, FileMode.READ);
            stream.readBytes(bytes);
            stream.close();
            if (looksLikeSwf(bytes))
            {
               return bytes;
            }
            trace("[DungeonBlitzAir] the kept game is not a SWF; downloading it again");
            file.deleteFile();
         }
         catch (error:Error)
         {
            trace("[DungeonBlitzAir] the kept game could not be read: " + error.message);
         }
         return null;
      }

      /** Keeps this build and drops any other: only the current client is ever played. */
      private function writeCached(bytes:ByteArray) : void
      {
         var file:File = cacheFile();
         if (!file)
         {
            return;
         }
         try
         {
            var folder:File = file.parent;
            folder.createDirectory();
            var partial:File = folder.resolvePath(file.name + ".part");
            var stream:FileStream = new FileStream();
            stream.open(partial, FileMode.WRITE);
            stream.writeBytes(bytes);
            stream.close();
            partial.moveTo(file, true);
            for each (var other:File in folder.getDirectoryListing())
            {
               if (other.name != file.name)
               {
                  other.deleteFile();
               }
            }
         }
         catch (error:Error)
         {
            // The game still plays; it is only downloaded again next time.
            trace("[DungeonBlitzAir] could not keep the game on disk: " + error.message);
         }
      }

      /** FWS, CWS or ZWS: an uncompressed, zlib or LZMA SWF. */
      private static function looksLikeSwf(bytes:ByteArray) : Boolean
      {
         if (!bytes || bytes.length < 8)
         {
            return false;
         }
         var first:uint = bytes[0];
         return (first == 0x46 || first == 0x43 || first == 0x5A) && bytes[1] == 0x57 && bytes[2] == 0x53;
      }

      // ---- the loading and error screens -------------------------------------------------------

      private function buildScreen() : void
      {
         Font.registerFont(AveriaRegular);
         Font.registerFont(AveriaBold);
         Font.registerFont(VollkornSemibold);
         Font.registerFont(VollkornBold);
         screen = new Sprite();
         backdrop = new Backdrop() as Bitmap;
         backdrop.smoothing = true;
         shade = new Sprite();
         ornamentTop = ornament();
         ornamentBottom = ornament();
         gameTitle = label(DISPLAY, 60, WHITE, true, -0.6);
         gameTitle.text = "Dungeon Blitz: R";
         screenTitle = label(DISPLAY, 26, GOLD, true, 0.5);
         screenBody = label(DISPLAY, 17, CREAM, false, 0);
         screenDetail = label(DISPLAY, 12, MUTED, false, 0.2);
         screenDetail.selectable = true;
         credit = label(UI, 12, WHITE, false, 1);
         credit.alpha = 0.7;
         credit.text = "REMAKE BY THE MINESA STUDIOS";
         progressTrack = new Sprite();
         progressFill = new Sprite();
         progressTrack.addChild(progressFill);
         buttons = new Sprite();
         for each (var part:Object in [backdrop, shade, ornamentTop, gameTitle, ornamentBottom, screenTitle, screenBody, progressTrack, buttons, screenDetail, credit])
         {
            screen.addChild(part as DisplayObject);
         }
         addChild(screen);
      }

      private static function label(font:String, size:int, color:uint, bold:Boolean, spacing:Number) : TextField
      {
         var field:TextField = new TextField();
         var format:TextFormat = new TextFormat(font, size, color, bold);
         format.align = TextFormatAlign.CENTER;
         format.leading = Math.round(size * 0.25);
         format.letterSpacing = spacing;
         field.defaultTextFormat = format;
         field.embedFonts = true;
         field.antiAliasType = AntiAliasType.ADVANCED;
         field.multiline = true;
         field.wordWrap = true;
         field.selectable = false;
         field.autoSize = TextFieldAutoSize.CENTER;
         return field;
      }

      /**
       * The site's divider: a thin line from a small diamond on each side, and three four-point
       * stars in the middle (large, small, large). Drawn at COLUMN wide, centred on x = 0.
       */
      private static function ornament() : Sprite
      {
         var art:Sprite = new Sprite();
         var g:Graphics = art.graphics;
         var half:Number = COLUMN / 2;
         var gap:Number = 66;
         g.lineStyle(1, WHITE, 0.85);
         g.moveTo(-half + 4, 0);
         g.lineTo(-gap, 0);
         g.moveTo(gap, 0);
         g.lineTo(half - 4, 0);
         g.lineStyle();
         g.beginFill(WHITE, 0.85);
         for each (var end:Number in [-half + 3, half - 3])
         {
            g.moveTo(end - 3, 0);
            g.lineTo(end, -3);
            g.lineTo(end + 3, 0);
            g.lineTo(end, 3);
            g.lineTo(end - 3, 0);
         }
         g.endFill();
         star(g, -36, 13);
         star(g, 0, 8);
         star(g, 36, 13);
         return art;
      }

      /** A four-point star with curved-in sides, `r` from its centre to each point. */
      private static function star(g:Graphics, cx:Number, r:Number) : void
      {
         var waist:Number = r * 0.18;
         g.beginFill(WHITE);
         g.moveTo(cx, -r);
         g.curveTo(cx + waist, -waist, cx + r, 0);
         g.curveTo(cx + waist, waist, cx, r);
         g.curveTo(cx - waist, waist, cx - r, 0);
         g.curveTo(cx - waist, -waist, cx, -r);
         g.endFill();
      }

      private function showLoading(title:String, fraction:Number) : void
      {
         errorBody = "";
         screenTitle.text = title.toUpperCase();
         screenBody.text = "";
         screenDetail.text = "";
         clearButtons();
         progress = fraction;
         progressTrack.visible = true;
         layoutScreen();
      }

      private function showError(title:String, body:String, detail:String) : void
      {
         errorBody = body;
         screenTitle.text = title.toUpperCase();
         screenDetail.text = detail;
         progressTrack.visible = false;
         clearButtons();
         addButton("Try again", true, onRetryClick);
         addButton("Quit", false, onQuitClick);
         retryLeft = RETRY_SECONDS;
         updateRetryText();
         stopRetryTimer();
         retryTimer = new Timer(1000);
         retryTimer.addEventListener(TimerEvent.TIMER, onRetryTick);
         retryTimer.start();
         layoutScreen();
      }

      /** A screen with nothing to do but read it. */
      private function showMessage(title:String, body:String) : void
      {
         errorBody = "";
         screenTitle.text = title.toUpperCase();
         screenBody.text = body;
         screenDetail.text = "";
         progressTrack.visible = false;
         clearButtons();
         layoutScreen();
      }

      private function updateRetryText() : void
      {
         screenBody.text = errorBody + "\nTrying again in " + retryLeft + " s.";
      }

      private function onRetryTick(event:TimerEvent) : void
      {
         retryLeft--;
         if (retryLeft <= 0)
         {
            loadGame();
            return;
         }
         updateRetryText();
         layoutScreen();
      }

      private function stopRetryTimer() : void
      {
         if (retryTimer)
         {
            retryTimer.stop();
            retryTimer.removeEventListener(TimerEvent.TIMER, onRetryTick);
            retryTimer = null;
         }
      }

      private function onRetryClick(event:MouseEvent) : void
      {
         loadGame();
      }

      private function onQuitClick(event:MouseEvent) : void
      {
         NativeApplication.nativeApplication.exit();
      }

      private function clearButtons() : void
      {
         while (buttons.numChildren > 0)
         {
            buttons.removeChildAt(0);
         }
      }

      /** The site's buttons: red with a gold edge for the main action, dark with a gold edge beside it. */
      private function addButton(text:String, primary:Boolean, onClick:Function) : void
      {
         var button:Sprite = new Sprite();
         button.buttonMode = true;
         button.mouseChildren = false;
         var caption:TextField = label(UI, 20, WHITE, true, -0.4);
         caption.wordWrap = false;
         caption.autoSize = TextFieldAutoSize.LEFT;
         caption.text = text.toUpperCase();
         var buttonWidth:Number = Math.max(196, caption.width + 56);
         var buttonHeight:Number = 52;
         var g:Graphics = button.graphics;
         g.lineStyle(1, GOLD);
         g.beginFill(primary ? RED : DARK, primary ? 1 : 0.72);
         g.drawRoundRect(0, 0, buttonWidth, buttonHeight, 8, 8);
         g.endFill();
         caption.x = (buttonWidth - caption.width) / 2;
         caption.y = (buttonHeight - caption.height) / 2;
         button.addChild(caption);
         button.x = buttons.numChildren == 0 ? 0 : buttons.width + 16;
         button.addEventListener(MouseEvent.CLICK, onClick);
         button.addEventListener(MouseEvent.ROLL_OVER, onScreenButtonHover);
         button.addEventListener(MouseEvent.ROLL_OUT, onScreenButtonHover);
         buttons.addChild(button);
      }

      private function onScreenButtonHover(event:MouseEvent) : void
      {
         Sprite(event.currentTarget).alpha = event.type == MouseEvent.ROLL_OVER ? 0.85 : 1;
      }

      private function drawProgress() : void
      {
         var g:Graphics = progressFill.graphics;
         g.clear();
         if (progress < 0)
         {
            return;
         }
         g.beginFill(GOLD);
         g.drawRoundRect(0, 0, Math.max(6, BAR_WIDTH * progress), 6, 6, 6);
         g.endFill();
      }

      /** The hero art covering the window, darkened, and one centred column; again on every change and resize. */
      private function layoutScreen() : void
      {
         if (!screen.parent)
         {
            return;
         }
         var w:Number = stage.stageWidth;
         var h:Number = stage.stageHeight;

         // Cover the window with the art, as the site's hero does, and darken it toward the right.
         var cover:Number = Math.max(w / backdrop.bitmapData.width, h / backdrop.bitmapData.height);
         backdrop.scaleX = backdrop.scaleY = cover;
         backdrop.x = Math.round((w - backdrop.width) / 2);
         backdrop.y = Math.round((h - backdrop.height) / 2);
         var sg:Graphics = shade.graphics;
         sg.clear();
         var m:Matrix = new Matrix();
         m.createGradientBox(w, h, 0);
         sg.beginGradientFill(GradientType.LINEAR, [INK, INK, INK], [0.55, 0.78, 0.9], [0, 140, 255], m);
         sg.drawRect(0, 0, w, h);
         sg.endFill();

         var column:Number = Math.min(COLUMN, w - 48);
         var text:Number = Math.min(560, column);
         gameTitle.width = column;
         screenTitle.width = text;
         screenBody.width = text;
         screenDetail.width = text;
         ornamentTop.scaleX = ornamentBottom.scaleX = column / COLUMN;
         screenBody.visible = screenBody.text.length > 0;
         screenDetail.visible = screenDetail.text.length > 0;
         buttons.visible = buttons.numChildren > 0;

         // Heights first, from y = 0; the whole column is then centred.
         var y:Number = 0;
         ornamentTop.y = y + 13;
         y += 26 + 14;
         gameTitle.y = y;
         y += gameTitle.height + 10;
         ornamentBottom.y = y + 13;
         y += 26 + 30;
         screenTitle.y = y;
         y += screenTitle.height + 10;
         if (screenBody.visible)
         {
            screenBody.y = y;
            y += screenBody.height + 26;
         }
         if (progressTrack.visible)
         {
            var tg:Graphics = progressTrack.graphics;
            tg.clear();
            tg.beginFill(WHITE, 0.16);
            tg.drawRoundRect(0, 0, BAR_WIDTH, 6, 6, 6);
            tg.endFill();
            drawProgress();
            progressTrack.y = y + 8;
            y += 6 + 34;
         }
         if (buttons.visible)
         {
            buttons.y = y;
            y += 52 + 26;
         }
         if (screenDetail.visible)
         {
            screenDetail.y = y;
            y += screenDetail.height;
         }
         var top:Number = Math.max(24, Math.round((h - y) / 2) - 20);
         var cx:Number = Math.round(w / 2);
         for each (var part:Object in [ornamentTop, gameTitle, ornamentBottom, screenTitle, screenBody, progressTrack, buttons, screenDetail])
         {
            part.y += top;
         }
         ornamentTop.x = ornamentBottom.x = cx;
         gameTitle.x = cx - column / 2;
         for each (var field:TextField in [screenTitle, screenBody, screenDetail])
         {
            field.x = cx - text / 2;
         }
         progressTrack.x = cx - BAR_WIDTH / 2;
         buttons.x = cx - buttons.width / 2;
         credit.width = 400;
         credit.x = cx - 200;
         credit.y = h - credit.height - 18;
      }

      // ---- full screen and the game's layout ---------------------------------------------------

      private function onKeyDown(event:KeyboardEvent) : void
      {
         // Ctrl+F (Cmd+F) as well: it is Flash Player's own full-screen key, which players know.
         if (event.keyCode == Keyboard.F11 || (event.keyCode == Keyboard.ENTER && event.altKey)
               || (event.keyCode == Keyboard.F && (event.ctrlKey || event.commandKey)))
         {
            toggleFullScreen();
         }
      }

      private function onFullScreenClick(event:MouseEvent) : void
      {
         toggleFullScreen();
      }

      private function onButtonHover(event:MouseEvent) : void
      {
         fullScreenButton.alpha = event.type == MouseEvent.ROLL_OVER ? 1 : 0.4;
      }

      /** Four corner brackets: pointing out to enter full screen, in to leave it. */
      private function drawFullScreenButton(full:Boolean) : void
      {
         var g:Graphics = fullScreenButton.graphics;
         g.clear();
         g.beginFill(0x1D1E26, 0.8);
         g.drawRoundRect(0, 0, 28, 28, 6, 6);
         g.endFill();
         g.lineStyle(2, 0xFFFFFF);
         var near:int = full ? 12 : 7;
         var far:int = full ? 16 : 21;
         var arm:int = full ? -5 : 5;
         g.moveTo(near, near + arm);
         g.lineTo(near, near);
         g.lineTo(near + arm, near);
         g.moveTo(far - arm, near);
         g.lineTo(far, near);
         g.lineTo(far, near + arm);
         g.moveTo(far, far - arm);
         g.lineTo(far, far);
         g.lineTo(far - arm, far);
         g.moveTo(near + arm, far);
         g.lineTo(near, far);
         g.lineTo(near, far - arm);
      }

      private function toggleFullScreen() : void
      {
         try
         {
            // Interactive, or AIR drops the keyboard in full screen and the game cannot be played.
            stage.displayState = stage.displayState == StageDisplayState.NORMAL ? StageDisplayState.FULL_SCREEN_INTERACTIVE : StageDisplayState.NORMAL;
         }
         catch (error:Error)
         {
            trace("[DungeonBlitzAir] full screen: " + error.message);
         }
      }

      /**
       * The game is shown 1:1 at the corner, in a window and in full screen alike. It sets the
       * stage to NO_SCALE itself and lays itself out to the whole stage, as it does in Flash
       * Player's full screen (Ctrl+F) and in a browser. Scaling it up as well put its full-screen
       * layout off the edges: about a quarter of the game was off screen.
       */
      private function fitGame(event:Event = null) : void
      {
         drawFullScreenButton(stage.displayState != StageDisplayState.NORMAL);
         fullScreenButton.x = stage.stageWidth - 28 - 8;
         fullScreenButton.y = 8;
         layoutScreen();
         if (!game)
         {
            return;
         }
         game.x = 0;
         game.y = 0;
         game.scaleX = 1;
         game.scaleY = 1;
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
   }
}
