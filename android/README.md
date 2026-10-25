# האפליקציה לאנדרואיד

אפליקציה קטנה שמציגה את האתר (טוענת אותו מ-`https://itaigree.github.io/InTheMiddle/`, כך שכל עדכון באתר
מגיע גם אליה), ומתחתיו באנר פרסומת של Google AdMob. האתר עצמו נשאר בלי פרסומות.

- קישורים ל-Waze, ל-Google Maps ולכל מקום אחר נפתחים באפליקציה המתאימה או בדפדפן.
- "המיקום שלי" מבקש את הרשאת המיקום של אנדרואיד בפעם הראשונה.
- לפני הפרסומות מוצג, במדינות שבהן החוק דורש, טופס ההסכמה של Google (UMP).

## בנייה

GitHub Actions בונה את האפליקציה בכל שינוי בתיקייה `android/` (וגם ידנית: Actions ← **Android app** ←
Run workflow). בדף ההרצה, תחת **Artifacts**, יש שני קבצים:

- **test-apk:** להתקנה ישירה בטלפון לבדיקה. תמיד עם פרסומות בדיקה של Google.
- **play-bundle:** קובץ AAB להעלאה ל-Google Play.

## מה צריך לעשות (בסדר הזה)

### 1. לנסות בטלפון
מורידים את test-apk מ-Actions, פותחים בטלפון ומאשרים התקנה ממקור לא מוכר.

### 2. חשבון AdMob
1. נרשמים ב-https://admob.google.com עם חשבון Google, וממלאים פרטי תשלום ומס.
2. **Apps ← Add app ← Android**, "לא פורסמה עדיין", שם: מקום באמצע.
3. באפליקציה: **Ad units ← Add ad unit ← Banner**.
4. מעתיקים שני מזהים: מזהה האפליקציה (`ca-app-pub-…~…`) ומזהה יחידת הבאנר (`ca-app-pub-…/…`).
5. ב-GitHub: **Settings ← Secrets and variables ← Actions ← Variables ← New repository variable**:
   - `ADMOB_APP_ID` = מזהה האפליקציה
   - `ADMOB_BANNER_ID` = מזהה הבאנר

   (הם לא סודיים: הם מופיעים בתוך כל אפליקציה.) מהבנייה הבאה, קובץ ה-AAB יציג פרסומות אמיתיות.
   **לא לוחצים על הפרסומות האמיתיות של עצמך**: Google עלולה לסגור על זה את החשבון.

### 3. מפתח העלאה (חתימה)
Google Play מקבלת רק קבצים חתומים. יוצרים מפתח פעם אחת, במחשב שיש בו Java:

```
keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

שומרים את `upload.jks` ואת הסיסמה במקום בטוח (אם הם הולכים לאיבוד, אפשר לבקש מ-Google מפתח חדש,
אבל זה לוקח זמן). ואז ב-GitHub, **Secrets** (לא Variables):

- `UPLOAD_KEYSTORE_BASE64` = התוכן של `base64 -w0 upload.jks` (ב-Mac: `base64 -i upload.jks`)
- `UPLOAD_KEYSTORE_PASSWORD` = סיסמת הקובץ
- `UPLOAD_KEY_ALIAS` = `upload`
- `UPLOAD_KEY_PASSWORD` = סיסמת המפתח (בדרך כלל אותה סיסמה)

### 4. Google Play Console
1. חשבון מפתח: https://play.google.com/console (25 דולר, פעם אחת, ואימות זהות).
2. **Create app**: שם, עברית, אפליקציה, חינם.
3. **Testing ← Closed testing**: מעלים את play-bundle. בחשבון פרטי חדש Google דורשת בדיקה סגורה
   (נכון לאחרונה: 12 בודקים לפחות, 14 יום) לפני שאפשר לפרסם לכולם.
4. ממלאים את הטפסים:
   - **Privacy policy**: `https://itaigree.github.io/InTheMiddle/privacy.html`
   - **Ads**: כן, האפליקציה מכילה פרסומות.
   - **Data safety**: מיקום (משוער ומדויק, לפעולת האפליקציה, לא נשמר, לא משותף לפרסום); מזהה
     פרסום ומידע על המכשיר (נאספים ע"י AdMob, לפרסום); הנתונים מוצפנים בדרך; אין חשבונות משתמשים.
   - **Content rating**, **Target audience** (18+ או 13+, לא ילדים).
5. דף החנות: תיאור קצר ומלא, אייקון 512×512 (`site/icons/icon-512.png`), תמונת באנר 1024×500,
   וצילומי מסך מהטלפון.

### 5. ‏app-ads.txt (מומלץ)
AdMob מאמת את האפליקציה דרך קובץ `app-ads.txt` בשורש אתר המפתח שרשום בחנות. אפשר בלי דומיין
משלך:

1. יוצרים ב-GitHub ריפו חדש בשם `itaigree.github.io`, ומפעילים בו Pages.
2. שמים בו קובץ `app-ads.txt` עם השורה מ-AdMob (**Apps ← View all apps ← app-ads.txt**), למשל:
   `google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0`
3. ב-Play Console, בפרטי הקשר, אתר המפתח: `https://itaigree.github.io`.

בלי הקובץ הפרסומות עדיין עובדות, אבל AdMob עשוי להציג פחות מהן.

## פרטים טכניים
- שם החבילה: `io.github.itaigree.inthemiddle`. אי אפשר לשנות אותו אחרי ההעלאה הראשונה.
- גרסה: מספר הגרסה (versionCode) הוא מספר ההרצה ב-Actions, כך שכל בנייה גבוהה מהקודמת. את שם
  הגרסה בוחרים כשמריצים ידנית.
- האפליקציה מוסיפה `InTheMiddleApp` לזיהוי הדפדפן (User-Agent), למקרה שהאתר ירצה לדעת שהוא רץ בה.
