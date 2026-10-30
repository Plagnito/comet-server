// Politique de mot de passe. zxcvbn estime localement la résistance (aucun appel
// réseau : compatible auto-hébergement et vie privée ; son dictionnaire couvre les
// mots de passe les plus courants/divulgués). On exige une longueur minimale ET un
// score zxcvbn suffisant, en pénalisant les passwords dérivés de l'e-mail/du nom.
import zxcvbn from 'zxcvbn';
import { AppError } from './errors.js';

const MIN_LEN = 10;
const MIN_SCORE = 2; // 0..4 (2 = « correct » ; rejette les mots de passe faibles/courants)

export function assertStrongPassword(password, userInputs = []) {
  const pw = String(password || '');
  if (pw.length < MIN_LEN) {
    throw new AppError(`Mot de passe : ${MIN_LEN} caractères minimum`, { status: 400, code: 'weak_password' });
  }
  const sanitizedInputs = userInputs.filter(Boolean).map((x) => String(x));
  const { score } = zxcvbn(pw, sanitizedInputs);
  if (score < MIN_SCORE) {
    throw new AppError(
      'Mot de passe trop faible (trop courant ou prévisible). Variez les caractères et évitez les mots, noms et dates évidents.',
      { status: 400, code: 'weak_password' },
    );
  }
}
