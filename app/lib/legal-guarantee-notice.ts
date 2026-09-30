import type {Locale} from './i18n';

// Unedited full-colour notices from the Commission's SVG archive, Annex I to
// Regulation (EU) 2025/1960. Source files: Legal guarantee_notice EN/NL/FR.svg.
// https://commission.europa.eu/document/download/27c45f1f-78a1-47a7-a7cc-adf23afee5ea_en?filename=SVG.zip
// Accessible transcript checked against the same notice in ENN/NLN/FRN.pdf:
// https://commission.europa.eu/document/download/29acbfc0-a26e-4c21-85af-8bc2b167103e_en?filename=Harmonised%20notice%20in%2024%20languages%20colour%20and%20black%20and%20white_0.zip
export const LEGAL_GUARANTEE_NOTICE = {
  en: {
    title: 'EU legal guarantee',
    image: 'Official EU legal guarantee notice',
    more: 'More about your legal guarantee rights on Your Europe',
    textVersion: 'Text version',
    url: 'https://europa.eu/youreurope/guarantees',
    assetPath: '/legal-guarantee/notice-en.svg',
    text: [
      'Minimum two-year legal guarantee protection for goods sold in the European Union.',
      'Consumers can claim their rights under the legal guarantee of conformity, for example if goods: do not match the description; do not function as intended.',
      'Sellers are liable for any lack of conformity which existed when the goods were delivered, and which becomes apparent within the legal guarantee period. Sellers in such a situation are required to offer: free repair or free replacement; in some cases, a price reduction or full reimbursement.',
      'Some countries have a longer legal guarantee period. For second-hand goods, a shorter period may apply, but not less than one year.',
      'For more information on your rights in a specific country, scan the QR code below or ask the seller.',
      'What to do if you receive non-conforming goods:',
      '1. Contact the seller as soon as possible to report the issue;',
      '2. Provide proof of purchase, such as a receipt, invoice, or bank statement.',
      'Sellers and producers may also offer commercial guarantees, which apply independently from the legal guarantee. For example, you may see this GARAN label representing a commercial guarantee of durability offered by the producer at no additional cost and covering the entire good.',
    ],
  },
  nl: {
    title: 'Wettelijke garantie in de EU',
    image: 'Officiële EU-kennisgeving over de wettelijke garantie',
    more: 'Meer over uw wettelijke garantierechten op Your Europe',
    textVersion: 'Tekstversie',
    url: 'https://europa.eu/youreurope/garantie',
    assetPath: '/legal-guarantee/notice-nl.svg',
    text: [
      'Minimaal twee jaar bescherming dankzij de wettelijke garantie voor goederen die in de Europese Unie worden verkocht.',
      'Consumenten kunnen hun rechten doen gelden op grond van de wettelijke conformiteitsgarantie, bijvoorbeeld als goederen: niet met de beschrijving overeenstemmen; niet naar behoren functioneren.',
      'Verkopers zijn aansprakelijk voor elk conformiteitsgebrek dat bestond bij de levering van de goederen en dat binnen de wettelijke garantieperiode aan het licht komt. Verkopers moeten in een dergelijke situatie het volgende aanbieden: gratis reparatie of gratis vervanging; in sommige gevallen, gedeeltelijke of volledige terugbetaling.',
      'Sommige landen hebben een langere wettelijke garantieperiode. Voor tweedehandsartikelen kan de garantieperiode korter zijn, maar niet korter dan één jaar.',
      'Als u meer wilt weten over uw rechten in een bepaald land, kunt u de QR-code hieronder scannen of de verkoper om informatie vragen.',
      'Wat moet u doen als u niet-conforme goederen ontvangt:',
      '1. Neem zo spoedig mogelijk contact op met de verkoper om het probleem te melden.',
      '2. Verstrek een aankoopbewijs, zoals een bon, een factuur of een rekeningafschrift.',
      'Verkopers en producenten kunnen ook commerciële garanties aanbieden, die los van de wettelijke garantie van toepassing zijn. Dit GARAN-label bijvoorbeeld staat voor een commerciële levensduurgarantie die kosteloos door de producent wordt aangeboden en het volledige goed dekt.',
    ],
  },
  fr: {
    title: 'Garantie légale dans l’UE',
    image: 'Notice officielle de l’UE sur la garantie légale',
    more: 'En savoir plus sur vos droits à la garantie légale sur Your Europe',
    textVersion: 'Version texte',
    url: 'https://europa.eu/youreurope/garanties',
    assetPath: '/legal-guarantee/notice-fr.svg',
    text: [
      'Protection offerte par la garantie légale minimale de deux ans sur des biens vendus dans l’Union européenne.',
      'Les consommateurs peuvent faire valoir leurs droits au titre de la garantie légale de conformité, par exemple si les biens: ne correspondent pas à la description; ne fonctionnent pas comme prévu.',
      'Les vendeurs sont responsables de tout défaut de conformité qui existait au moment de la livraison des biens et qui apparaît pendant la période de garantie légale. Les vendeurs se trouvant dans une telle situation sont tenus de proposer: une réparation gratuite ou un remplacement gratuit; dans certains cas, une réduction de prix ou un remboursement intégral.',
      'Dans certains pays, la période de garantie légale est plus longue. Pour les biens d’occasion, une période plus courte peut s’appliquer, mais elle ne peut être inférieure à un an.',
      'Pour en savoir plus sur vos droits dans un pays donné, scannez le code QR ci-dessous ou consultez le vendeur.',
      'Que faire si vous recevez des biens non conformes:',
      '1. Contactez le vendeur dès que possible pour signaler le problème;',
      '2. Fournissez une preuve d’achat, telle qu’un reçu, une facture ou un relevé bancaire.',
      'Les vendeurs et les producteurs peuvent également offrir des garanties commerciales, qui s’appliquent indépendamment de la garantie légale. Par exemple, il se peut que votre bien affiche ce label GARAN, représentant une garantie commerciale de durabilité offerte par le producteur sans frais supplémentaires et s’appliquant à l’ensemble du bien.',
    ],
  },
} satisfies Record<Locale, {
  title: string;
  image: string;
  more: string;
  textVersion: string;
  url: string;
  assetPath: string;
  text: string[];
}>;
