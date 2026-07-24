import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Html5QrcodeScanner } from "html5-qrcode";
import { Camera, CheckCircle2, XCircle, LogIn, RefreshCw, AlertTriangle, LogOut } from "lucide-react";
import { useAttendanceScan, ScanResponse } from "../hooks/useAttendanceScan";

type State = "idle" | "scanning" | "success_in" | "success_out" | "error";

export default function Scan() {
  const navigate = useNavigate();
  const { scan } = useAttendanceScan();

  const [state, setState] = useState<State>("idle");
  const [operatorName, setOperatorName] = useState("");
  const [latenessMsg, setLatenessMsg] = useState("");
  const [durationMsg, setDurationMsg] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const scannerRef = useRef<Html5QrcodeScanner | null>(null);

  const startScanner = () => {
    setState("scanning");
  };

  useEffect(() => {
    if (state !== "scanning") {
      if (scannerRef.current) {
        try {
          scannerRef.current.clear();
        } catch (e) {
          // ignore
        }
        scannerRef.current = null;
      }
      return;
    }

    // Delay initialization slightly to ensure element with id 'qr-reader' is mounted
    const timer = setTimeout(() => {
      const scanner = new Html5QrcodeScanner(
        "qr-reader",
        { fps: 10, qrbox: 250 },
        /* verbose= */ false
      );

      scanner.render(
        async (decodedText) => {
          // Success callback
          try {
            // Stop scanning immediately before calling API to prevent double-scan
            scanner.clear();
            scannerRef.current = null;

            const res = await scan(decodedText);
            setOperatorName(res.operator.full_name);

            if (res.action === "check_in") {
              if (res.was_late) {
                setLatenessMsg("Вы опоздали!");
              } else {
                setLatenessMsg("");
              }
              setState("success_in");
            } else {
              setDurationMsg(`Смена закрыта. Длительность: ${res.duration_min} мин.`);
              setState("success_out");
            }
          } catch (err: any) {
            const status = err.response?.status;
            if (status === 410) {
              setErrorMessage("Ваш QR-код отозван. Обратитесь к тимлиду за новым.");
            } else if (status === 429) {
              setErrorMessage("Слишком часто! Подождите 30 секунд между сканированиями.");
            } else if (status === 403) {
              setErrorMessage("Сканирование заблокировано: это устройство находится вне офисной сети.");
            } else if (status === 400) {
              setErrorMessage("Неверный QR-код. Отсканируйте актуальный код из профиля.");
            } else {
              setErrorMessage("Ошибка подключения к серверу. Попробуйте еще раз.");
            }
            setState("error");
          }
        },
        () => {
          // Silent scan failure
        }
      );

      scannerRef.current = scanner;
    }, 100);

    return () => {
      clearTimeout(timer);
      if (scannerRef.current) {
        try {
          scannerRef.current.clear();
        } catch (e) {
          // ignore
        }
      }
    };
  }, [state]);

  // Handle redirects on success
  useEffect(() => {
    if (state === "success_in") {
      const timer = setTimeout(() => {
        navigate("/");
      }, 1500);
      return () => clearTimeout(timer);
    }
    if (state === "success_out") {
      const timer = setTimeout(() => {
        setState("idle");
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [state, navigate]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center p-4">
      {/* Header link */}
      <div className="absolute top-6 right-6">
        <Link
          to="/login"
          className="flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-500 transition"
        >
          <LogIn className="w-4 h-4" />
          Войти по паролю
        </Link>
      </div>

      <div className="w-full max-w-md card p-6 md:p-8 text-center space-y-6 shadow-xl">
        {state === "idle" && (
          <div className="space-y-6 py-4">
            <div className="w-16 h-16 bg-blue-50 dark:bg-slate-900 text-blue-600 rounded-2xl flex items-center justify-center mx-auto">
              <Camera className="w-8 h-8" />
            </div>
            <div className="space-y-2">
              <h1 className="text-xl md:text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
                Быстрый вход по QR
              </h1>
              <p className="text-sm text-gray-500 dark:text-slate-400 leading-relaxed">
                Покажите ваш личный QR-код веб-камере, чтобы начать смену и войти в систему.
              </p>
            </div>
            <button onClick={startScanner} className="btn-primary w-full py-3 flex items-center justify-center gap-2">
              <Camera className="w-5 h-5" />
              Включить камеру
            </button>
          </div>
        )}

        {state === "scanning" && (
          <div className="space-y-4">
            <h2 className="font-bold text-gray-900 dark:text-white">Сканирование QR</h2>
            <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-slate-800 bg-black aspect-square max-w-xs mx-auto">
              <div id="qr-reader" className="w-full h-full" />
            </div>
            <p className="text-xs text-gray-500">Поднесите ваш QR-код к камере устройства</p>
            <button
              onClick={() => setState("idle")}
              className="btn-ghost text-sm text-red-600 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 w-full"
            >
              Отмена
            </button>
          </div>
        )}

        {state === "success_in" && (
          <div className="space-y-4 py-8 animate-pulse">
            <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto" />
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Добро пожаловать!</h2>
              <p className="text-lg font-semibold text-emerald-600 mt-1">{operatorName}</p>
              <p className="text-sm text-gray-500 mt-2">Смена успешно открыта.</p>
              {latenessMsg && (
                <div className="mt-4 px-3 py-1 bg-amber-50 dark:bg-amber-950/20 text-amber-600 border border-amber-200 dark:border-amber-900/30 rounded-full inline-flex items-center gap-1 text-xs font-semibold">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {latenessMsg}
                </div>
              )}
            </div>
          </div>
        )}

        {state === "success_out" && (
          <div className="space-y-4 py-8">
            <LogOut className="w-16 h-16 text-blue-500 mx-auto" />
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Смена завершена</h2>
              <p className="text-lg font-semibold text-blue-600 mt-1">{operatorName}</p>
              <p className="text-sm text-gray-500 mt-2">{durationMsg}</p>
              <p className="text-xs text-gray-400 mt-4">До встречи завтра!</p>
            </div>
          </div>
        )}

        {state === "error" && (
          <div className="space-y-6 py-4">
            <XCircle className="w-16 h-16 text-red-500 mx-auto" />
            <div className="space-y-2">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">Ошибка сканирования</h2>
              <p className="text-sm text-gray-600 dark:text-slate-400">{errorMessage}</p>
            </div>
            <button
              onClick={() => setState("scanning")}
              className="btn-primary w-full py-2.5 flex items-center justify-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              Повторить попытку
            </button>
            <button
              onClick={() => setState("idle")}
              className="btn-ghost w-full text-sm text-gray-500"
            >
              Вернуться на главную
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
