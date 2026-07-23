import { useState } from 'react';
import { tgStart, tgVerifyCode, tgVerifyPassword } from '../lib/tgUserclient';
import { Modal } from './Modal';
import { apiErrorMessage } from '../lib/api-types';

export default function TgConnectWizard({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleStart = async () => {
    setError('');
    if (!consent) {
      setError('Необходимо согласие');
      return;
    }
    try {
      const res = await tgStart(phone, consent);
      setSessionId(res.data.session_id);
      setStep(2);
    } catch (err: unknown) {
      setError(apiErrorMessage(err));
    }
  };

  const handleVerifyCode = async () => {
    if (!sessionId) return;
    setError('');
    try {
      const res = await tgVerifyCode(sessionId, code);
      if (res.data.status === 'pending_2fa') {
        setStep(3);
      } else {
        onSuccess();
        onClose();
      }
    } catch (err: unknown) {
      setError(apiErrorMessage(err));
    }
  };

  const handleVerifyPassword = async () => {
    if (!sessionId) return;
    setError('');
    try {
      const res = await tgVerifyPassword(sessionId, password);
      if (res.data.status === 'active') {
        onSuccess();
        onClose();
      }
    } catch (err: unknown) {
      setError(apiErrorMessage(err));
    }
  };

  return (
    <Modal open={true} title="Подключение Telegram" onClose={onClose}>
        
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className="label">Номер телефона (с кодом)</label>
              <input
                className="input"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+998901234567"
              />
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-600 dark:text-slate-300">
              <input
                type="checkbox"
                className="mt-1"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                Я разрешаю системе naffAI подключиться к моему Telegram-аккаунту в режиме чтения для анализа переписки с клиентами компании. Я обязуюсь предупреждать клиентов о том, что переписка обрабатывается в CRM-системе.
              </span>
            </label>
            {error && <div className="text-red-500 text-sm">{error}</div>}
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-ghost" onClick={onClose}>Отмена</button>
              <button className="btn-primary" onClick={handleStart} disabled={!phone || !consent}>
                Отправить код
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <label className="label">Код из Telegram</label>
              <input
                className="input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            {error && <div className="text-red-500 text-sm">{error}</div>}
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-ghost" onClick={onClose}>Отмена</button>
              <button className="btn-primary" onClick={handleVerifyCode} disabled={!code}>
                Подтвердить
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <label className="label">Облачный пароль (2FA)</label>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <div className="text-red-500 text-sm">{error}</div>}
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-ghost" onClick={onClose}>Отмена</button>
              <button className="btn-primary" onClick={handleVerifyPassword} disabled={!password}>
                Подтвердить пароль
              </button>
            </div>
          </div>
        )}
    </Modal>
  );
}
