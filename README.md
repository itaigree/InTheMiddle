# מקום באמצע

מכניסים שתי נקודות יציאה, ומקבלים מקומות בילוי שנמצאים בערך באותו זמן נסיעה משני הצדדים:
בתי קפה, קניונים, פארקים, מקומות טבע ונוף, מסעדות ואטרקציות.

**כתובת האפליקציה:** https://itaigree.github.io/InTheMiddle/

## מה האפליקציה עושה

1. ממירה את שני השמות שהוקלדו לנקודות על המפה (עם השלמה אוטומטית בזמן ההקלדה).
2. מחשבת את המסלול בין שתי הנקודות, ובודקת זמני נסיעה משני הצדדים לנקודות לאורכו.
   כך היא מוצאת את הנקודה שבה **זמן** הנסיעה שווה, ולא רק את אמצע המרחק.
3. מחפשת סביב הנקודה הזו מקומות מהסוגים שנבחרו.
4. בודקת לכל מקום כמה זמן לוקח להגיע אליו מכל צד, ומדרגת לפי הנסיעה הארוכה מבין השתיים,
   לפי ההפרש בין הצדדים ולפי הדירוג של המקום.
5. מציגה מפה ורשימה, עם כפתורי ניווט ב-Waze וב-Google Maps ושיתוף בקישור.

כל צד בוחר אם הוא מגיע ברכב או בתחבורה ציבורית. אפשר גם לבחור זמן יציאה עתידי,
וזה חשוב במיוחד בתחבורה ציבורית (למשל בשבת).

## מקורות הנתונים

| מצב | מתי | מה מקבלים |
| --- | --- | --- |
| **Google Maps** | כשמוגדר מפתח API ועוד לא נגמרה המכסה היומית | דירוגים, תמונות, שעות פתיחה, זמני נסיעה שמביאים בחשבון פקקים, תחבורה ציבורית |
| **OpenStreetMap** | בלי מפתח, או כשהמכסה של Google נגמרה | מפה וזמני נסיעה ברכב, מקומות מ-OpenStreetMap, בלי דירוגים |

המעבר אוטומטי: כש-Google מחזירה שגיאת מכסה (או שגיאת מפתח), האפליקציה עוברת ל-OpenStreetMap,
מציגה הודעה קצרה, וחוזרת לנסות את Google אחרי שהמכסה היומית מתאפסת.

## הקמה (פעם אחת)

### 1. GitHub Pages

1. **להפוך את ה-repo לציבורי:** ‏Settings ← General ← בתחתית העמוד, Danger Zone ← **Change visibility** ← Public.
   (ב-GitHub חינמי, Pages עובד רק עם repo ציבורי. מפתח ה-API לא נשמר בקוד, אלא ב-Secret.)
2. **להפעיל את Pages:** ‏Settings ← Pages ← Build and deployment ← Source: **GitHub Actions**.
3. כל push ל-`main` מריץ בדיקות ומפרסם את האתר. אפשר לראות את ההרצות בלשונית **Actions**.

גם בלי מפתח של Google האתר עובד, במצב OpenStreetMap.

### 2. מפתח Google Maps (בשביל דירוגים, תמונות ותחבורה ציבורית)

1. נכנסים ל-[Google Cloud Console](https://console.cloud.google.com/) ← בוחרים פרויקט ← **New Project** (למשל `InTheMiddle`).
2. **Billing** ← מקשרים חשבון חיוב (כרטיס אשראי). בלי חשבון חיוב, Google מגבילה לבקשה אחת ביום.
   לא יהיה חיוב כל עוד נשארים בתוך המכסות היומיות שבסעיף 5.
3. **APIs & Services ← Library** ← מפעילים את שלושת אלה בדיוק:
   - **Maps JavaScript API**
   - **Places API (New)**
   - **Routes API**

   (לא צריך את הגרסאות הישנות: Places API, ‏Directions API, ‏Distance Matrix API.)
4. **Google Maps Platform ← Keys & Credentials ← Create credentials ← API key**, ואז עורכים את המפתח:
   - **Application restrictions** ← Websites ← מוסיפים `https://itaigree.github.io/*`
   - **API restrictions** ← Restrict key ← מסמנים את שלושת ה-API מסעיף 3
   - Save. השינוי נכנס לתוקף תוך כמה דקות.
5. **מכסות יומיות.** זה החלק שמבטיח שלא יהיה חיוב. ב-**Google Maps Platform ← Quotas** בוחרים כל API,
   מוצאים את השורה שמסתיימת ב-**per day**, לוחצים על העיפרון, מבטלים את Unlimited ומזינים ערך:

   | API | מכסה | ערך יומי מומלץ |
   | --- | --- | --- |
   | Places API (New) | SearchNearbyRequest per day | **32** |
   | Places API (New) | GetPhotoMediaRequest per day (אם קיים) | **32** |
   | Places API (New) | AutocompletePlacesRequest per day | 300 |
   | Places API (New) | GetPlaceRequest per day | 300 |
   | Routes API | ComputeRouteMatrix (per day, אם קיים) | 300 |
   | Routes API | ComputeRoutes per day | 300 |
   | Maps JavaScript API | Map loads per day (אם קיים) | 300 |

   **מאיפה המספרים:** בכל חודש Google נותנת בחינם 1,000 חיפושי מקומות עם דירוגים ושעות פתיחה,
   1,000 תמונות ו-10,000 מכל השאר. 1,000 חלקי 31 ימים זה בערך 32 ביום.
   חיפוש אחד שולח בקשת חיפוש מקומות אחת לכל סוג מקום שנבחר (4 כברירת מחדל), ולכן יוצאים
   **כ-8 חיפושים ביום עם Google**. אחרי זה, ועד חצות לפי שעון קליפורניה (10:00 בבוקר בישראל), האפליקציה
   עוברת אוטומטית ל-OpenStreetMap.
6. **Map ID** (בשביל הסמנים במפה): ‏Google Maps Platform ← **Map management ← Create Map ID** ←
   שם כלשהו, סוג **JavaScript**, ‏**Vector** ← Save. מעתיקים את ה-Map ID (הוא לא סוד).
7. מומלץ גם: **Billing ← Budgets & alerts ← Create budget** עם סכום קטן (למשל 5$) והתראות.
   תקציב רק שולח מייל ולא עוצר שימוש. מה שעוצר בפועל הן המכסות היומיות שבסעיף 5.

### 3. לחבר את המפתח לאתר

ב-GitHub: ‏Settings ← Secrets and variables ← Actions:
- בלשונית **Secrets** ← New repository secret ← שם: `GOOGLE_MAPS_API_KEY`, ערך: המפתח.
- בלשונית **Variables** ← New repository variable ← שם: `GOOGLE_MAP_ID`, ערך: ה-Map ID.

אחרי זה מריצים את הפריסה מחדש (Actions ← Test and deploy ← Run workflow), או פשוט עושים push.

**בדיקה:** פותחים את האתר ומחפשים. בתחתית העמוד כתוב "Google Maps". אם כתוב OpenStreetMap,
אפשר לפתוח את הקונסול בדפדפן (F12) ולחפש שגיאות כמו `RefererNotAllowedMapError` או `ApiNotActivatedMapError`.

## פיתוח מקומי

אין שלב build. כל האתר נמצא בתיקייה `site/`.

```bash
npm test            # בדיקות יחידה (Node 22)
npm run serve       # שרת מקומי בכתובת http://localhost:8080
npm run test:e2e    # בדיקות בדפדפן אמיתי, עם כל השירותים החיצוניים מדומים
```

בדיקות הדפדפן צריכות Playwright: `npm i -D playwright && npx playwright install chromium`.
הן מכסות את מצב OpenStreetMap, את מצב Google (מול SDK מדומה שנמצא ב-`tests/e2e/fake-google-maps.js`),
ואת המעבר האוטומטי כשהמכסה נגמרת או כשהמפתח לא תקין.

כדי לבדוק מקומית עם Google, אפשר לשים מפתח בקובץ `site/config.js` (ולא לעשות לזה commit),
ולהוסיף את `http://localhost:8080/*` להגבלות המפתח.
כדי לבדוק את מצב OpenStreetMap גם כשיש מפתח, מוסיפים לכתובת `?p=osm`.

## מבנה הקוד

```
site/
  index.html, styles.css      ממשק המשתמש (עברית, מימין לשמאל, מותאם לטלפון)
  config.js                   הגדרות (נכתב מחדש בזמן הפריסה)
  js/main.js                  חיבור הטופס, החיפוש, המפה והמעבר בין ספקים
  js/core/                    לוגיקה שלא תלויה בספק: חישוב האמצע, דירוג, פורמט, קישור לשיתוף
  js/providers/google.js      Google Maps Platform
  js/providers/osm.js         OpenStreetMap ושירותים פתוחים
  js/ui/                      השלמה אוטומטית, מפות, כרטיסי תוצאות
tests/unit/                   בדיקות יחידה (node --test)
.github/workflows/deploy.yml  בדיקות ופריסה ל-GitHub Pages
```
