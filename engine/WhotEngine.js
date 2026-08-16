class WhotEngine {
  static SHAPES = ['Circle', 'Triangle', 'Cross', 'Square', 'Star'];
  static NUMBERS = [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14];

  static generateDeck() {
    let deck = [];
    let id = 1;
    for (let shape of this.SHAPES) {
      for (let num of this.NUMBERS) {
        if (shape === 'Star' && ![1, 2, 3, 4, 5, 7, 8].includes(num)) continue;
        deck.push({ id: id++, shape, number: num });
      }
    }
    for (let i = 0; i < 5; i++) {
      deck.push({ id: id++, shape: 'Whot', number: 20 });
    }
    return this.shuffle(deck);
  }

  static shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  static validateMove(cardToPlay, topCard, requestedShape) {
    if (cardToPlay.number === 20) return true;
    if (topCard.number === 20 && requestedShape) {
      return cardToPlay.shape === requestedShape;
    }
    return cardToPlay.shape === topCard.shape || cardToPlay.number === topCard.number;
  }

  static calculateHandSum(hand) {
    return hand.reduce((sum, card) => sum + card.number, 0);
  }

  static process2PlayerPayout(stake) {
    const winnerReward = stake * 0.80;
    const houseRake = stake * 0.20;
    return { winnerReward, houseRake };
  }

  static process4PlayerElimination(loserStake) {
    const rewardPerPlayer = (loserStake * 0.25) / 3;
    const houseRake = loserStake * 0.25;
    return { rewardPerPlayer, houseRake };
  }
}

module.exports = WhotEngine;