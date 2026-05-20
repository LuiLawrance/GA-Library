import api_ga
import sys
import user


def main():
    print("\n=== Grand Archive Library ===")

    while True:
        input_user = input(
            "\nEnter your username, 1 to search for a card, 4 to create a new user, 5 to reset your password, or 0 to exit: ").strip()

        if input_user == "0":
            print("Exiting program.")
            sys.exit()

        elif input_user == "1":
            while True:
                input_card = input("\nEnter your card name or 0 to exit: ").strip()

                while not input_card:
                    print("Card name cannot be empty.")
                    input_card = input("Enter your card name or 0 to exit: ").strip()

                if input_card == "0":
                    break

                card_id = api_ga.card_search(input_card)

                if card_id:
                    api_ga.print_card(card_id, "")

        elif input_user == "4":
            username = input("Enter new username: ").strip()

            while not username:
                print("Username cannot be empty.")
                username = input("Enter new username: ").strip()

            while user.check_user(username):
                print("Username already exists.")
                username = input("Enter new username: ").strip()

            password = input("Enter your password: ").strip()
            user.new_user(username, password)

        elif input_user == "5":
            username = input("Enter your username: ").strip()

            while not username:
                print("Username cannot be empty.")
                username = input("Enter new username: ").strip()

            if user.check_user(username):
                user.reset_password(username)
            else:
                print("Username does not exist.")

        else:
            if user.check_user(input_user):
                input_password = input("Enter your password: ").strip()
                current_user = user.user_login(input_user, input_password)

                if current_user:
                    while True:
                        input_card = input("\nEnter a card name to search, or 0 to log out: ").strip()

                        while not input_card:
                            print("Card name cannot be empty.")
                            input_card = input("Enter a card name to search, or 0 to log out: ").strip()

                        if input_card == "0":
                            print(f"Logged out of {current_user}.")
                            break

                        card_id = api_ga.card_search(input_card)

                        if card_id:
                            api_ga.print_card(card_id, current_user)

            else:
                print("User does not exist.")


if __name__ == '__main__':
    main()
