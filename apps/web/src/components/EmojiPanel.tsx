import { useEffect, useRef } from 'react';
import EmojiPicker, {
  Categories,
  EmojiStyle,
  Theme,
  type EmojiClickData,
} from 'emoji-picker-react';

interface Props {
  onPick: (emoji: string) => void;
  onClose: () => void;
  // Mode réaction : barre d'emojis rapides, « + » pour la liste complète.
  reactions?: boolean;
  className?: string;
}

// Libellés français des catégories (la bibliothèque est en anglais).
const CATEGORIES = [
  { category: Categories.SUGGESTED, name: 'Récents' },
  { category: Categories.SMILEYS_PEOPLE, name: 'Smileys et personnes' },
  { category: Categories.ANIMALS_NATURE, name: 'Animaux et nature' },
  { category: Categories.FOOD_DRINK, name: 'Nourriture et boissons' },
  { category: Categories.TRAVEL_PLACES, name: 'Voyages et lieux' },
  { category: Categories.ACTIVITIES, name: 'Activités' },
  { category: Categories.OBJECTS, name: 'Objets' },
  { category: Categories.SYMBOLS, name: 'Symboles' },
  { category: Categories.FLAGS, name: 'Drapeaux' },
];

// Réactions rapides de WhatsApp (codes « unified » attendus par la bibliothèque).
const QUICK_REACTIONS = ['1f44d', '2764-fe0f', '1f602', '1f62e', '1f622', '1f64f'];

// Sélecteur d'emojis en popover : se ferme sur Échap ou clic à l'extérieur.
// Emojis natifs (aucune image chargée depuis un CDN).
export default function EmojiPanel({ onPick, onClose, reactions, className }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const dark = document.documentElement.dataset.theme === 'dark';
  const pick = (d: EmojiClickData) => onPick(d.emoji);

  return (
    <div ref={ref} className={'emojipanel ' + (className ?? '')}>
      <EmojiPicker
        onEmojiClick={pick}
        onReactionClick={pick}
        reactionsDefaultOpen={reactions ?? false}
        reactions={QUICK_REACTIONS}
        allowExpandReactions
        emojiStyle={EmojiStyle.NATIVE}
        theme={dark ? Theme.DARK : Theme.LIGHT}
        categories={CATEGORIES}
        searchPlaceHolder="Rechercher (en anglais : heart, smile…)"
        previewConfig={{ showPreview: false }}
        lazyLoadEmojis
        width={320}
        height={380}
      />
    </div>
  );
}
